const {
    desktopCapturer
} = require('electron');


let fpsCnt = 0
function fpsTick() {
    fpsCnt++
    window.requestAnimationFrame(fpsTick)
}
fpsTick()
var fpsInterval = setInterval(() => {
    // do the thing with fps
    document.getElementById('fps').innerHTML = fpsCnt + ' FPS'
    fpsCnt = 0
}, 1000)


var socket = initWebSocket();
getOwnWindow().then(win => {
    let video = document.querySelector('video');
    return init(win, video);
}).catch(e => {
    console.log('getUserMediaError: ' + JSON.stringify(e, null, '---'));
}).then(video => {
    //give a name and a bounding box
    //giving x,y,width and height
    loadChars();

    initCapture(video, {
        'time': [100, 44, 200, 23],
        'speed': [70, 224, 105, 23],
        'altitude': [265, 222, 105, 23]
    });
});

/**
 * gets the application window handle
 */
function getOwnWindow() {
    console.log('getting capture stream');
    return new Promise((resolve, reject) => {
        desktopCapturer.getSources({
            types: ['window']
        }, function(error, sources) {
            if (error) {
                console.log('error getting capture stream');
                reject(error);
            } else {
                resolve(sources.filter(s => s.name === document.title)[0]);
            }
        });

    });
}

/**
 * inits the video capture and streams to video element
 */
function init(win, video) {
    console.log('initing media stream to video element');
    return new Promise((resolve, reject) => {
        console.log("Desktop sharing started.. desktop_id:" + win.id);
        navigator.webkitGetUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: win.id,
                    minWidth: window.outerWidth,
                    minHeight: window.outerHeight,
                    maxWidth: window.outerWidth,
                    maxHeight: window.outerHeight,
                }
            }
        }, gotStream, reject);

        function gotStream(stream) {
            video.src = URL.createObjectURL(stream);
            resolve(video);
        }
    })
}

/**
 * capture the given slices to canvas elements
 * these elements are already defined in the page
 */
function initCapture(video, slices) {
    /**
     * convert the slices to an array of
     * {
     *     el: the canvas element given by the key selector
     *     ctx: the drawing context of the canvas
     *     boundingBox: the boundingBox [x,y,w,h] given by the value
     *     name: the buffer name
     * }
     */
    var buffers = document.querySelector('#buffers');
    var data = Object.keys(slices).map(name => {
        var selector = '#'+name;
        var el = document.createElement('canvas');
        buffers.appendChild(el);
        var boundingBox = slices[name];
        el.width = boundingBox[2];
        //two times the height to be able to draw a backbuffer
        el.height = boundingBox[3] * 2;
        var ctx = el.getContext('2d');
        return {
            el,
            ctx,
            boundingBox,
            name
        };
    });

    // draw each slice
    function draw() {
        let result = data.reduce((data, spec) => {
            let result = slice(spec.boundingBox, video, spec);
            data[spec.name] = result;
            return data;
        }, {});
        /*
         {
         "time": "00:00:05",
         "speed": "00010",
         "altitude": "00.2"
         }

         {
         "time": "00:01:24",
         "speed": "00570",
         "altitude": "17.1"
         }

         {
         "time": "00:03:22",
         "speed": "02072",
         "altitude": "113"
         }
         */

        if (
            /^\d{2}:\d{2}:\d{2}$/.test(result.time) &&
            /^\d{5}$/.test(result.speed) &&
            /^(?:\d{3}|\d{2}\.\d)$/.test(result.altitude)
        ) {
          log(result);
          socket.send('telemetry',result);
        } else {
          log('bad frame');
        }

        requestAnimationFrame(draw);
    }

    setTimeout(draw, 2000);
}

var classifierContext = document.querySelector('#classifier').getContext('2d');
var debug = document.querySelector('#debug');
var log = (data) => {
    debug.innerHTML = JSON.stringify(data, null, 2);
}

var characters = [];
var glyphs = '0123456789.:'.split('');

function loadChars() {
    //copy image data to classifier canvas
    classifierContext.drawImage(document.querySelector('#chars'),0,0);
    //load the pixel data in the characters array
    var w = 192, h = 16;
    var data = classifierContext.getImageData(0,0,w,h).data;
    for (var i=0; i<data.length; i+=4) {
        var col = (i / 4) % w;
        var row = Math.floor((i / 4) / w);
        var charIndex = Math.floor(col / 16);
        var charCol = col % 16;
        var pixelIndex = charCol + row * 16;
        if (!characters[charIndex]) {
            characters[charIndex] = [];
        }
        characters[charIndex][pixelIndex] = data[i] / 255;
    }
}

//tries to classify 
function classify({ctx, el}, slice) {
    var imageData = ctx.getImageData(16 * slice.index, 23, 16, 16);
    var data = imageData.data;
    var overlaps = characters.map((characterData, index) => {
        let total = characterData.reduce((total, pixel, index) => {
            let similarity = 1 - Math.abs(pixel - (data[index * 4] / 255));
            return total + similarity
        }, 0);
        return {
            overlap: total / 256,
            index
        }
    });
    var sorted = overlaps.sort((a,b) => {
        if (a.overlap == b.overlap) return 0;
        return a.overlap > b.overlap? -1: 1;
    });
    var best = sorted[0];
    var index = best.index;

    //draw the slice at the specified index to see how much they change
    classifierContext.drawImage(el, 16*slice.index, 23, 16, 16, 16*index, 0, 16,16)
    return glyphs[index];
}

// extracts frames and individual characters to the defined canvas
// first step is to capture the area of interest to greyscale (upper half)
// next step is to only crop out individual characters based on segmentation (lower half)
function slice(boundingBox, video, spec) {
    let baseX = 0;
    let baseY = 23;

    var {ctx, el} = spec;
    var [x, y, w, h] = boundingBox;

    // apply calibration
    x += baseX
    y += baseY

    ctx.drawImage(video, x, y, w, h, 0, 0, w, h);
    //get it back as data, make bw and put it
    var [imageData, slices] = toBlackAndWhite(ctx.getImageData(0, 0, w, h), boundingBox);
    ctx.putImageData(imageData, 0, 0);
    var result = '';
    slices.forEach((slice, i) => {
        if (slice.start && slice.width) {
            //draw the slices as 16x16 images in the lower half of the canvas
            ctx.drawImage(el, slice.start, 0, slice.width, h, i* 16, h, 16, 16);
            result += classify(spec, slice)
        }
    })
    return result;
}

//converts the umagedata to black and white pixels
function toBlackAndWhite(imageData, boundingBox) {
    var data = imageData.data;
    var whitest = 0;
    var blackest = 255;
    //get a greyscale version of the data in the bounding box
    //storing the whitest and the blackest value in the process
    for (var i = 0; i < data.length; i += 4) {
        var r = data[i];
        var g = data[i + 1];
        var b = data[i + 2];
        var brightness = (3 * r + 4 * g + b) >>> 3;
        whitest = Math.max(whitest, brightness);
        blackest = Math.min(blackest, brightness);
        var bw = brightness;
        data[i] = bw;
        data[i + 1] = bw;
        data[i + 2] = bw;
    }
    var threshold = (whitest + blackest) * 0.4;
    var segments = {cols: [], rows: []};
    //threshold the greyscale image in the middle of the range
    //storing segment boundaries in the meantime
    for (var i = 0; i < data.length; i += 4) {
        var bw = br = data[i];
        var range = 10;
        if (br < (threshold - range)) {
            bw = 0;
        }
        if (br > (threshold + range)) {
            bw = 255;
        }
        //calculate segmentation
        var col = (i / 4) % boundingBox[2];
        if (segments.cols[col] === undefined) {
            segments.cols[col] = 0;
        }
        segments.cols[col] = segments.cols[col] + bw;
        // segments.cols[col] = Math.max(segments.cols[col], bw);
        data[i] = bw;
        data[i + 1] = bw;
        data[i + 2] = bw;
    }
    // visualize segments masks
    // for (var i = 0; i < data.length; i += 4) {
    //     var col = (i / 4) % boundingBox[2];
    //     var isWhite = segments.cols[col] > 255;
    //     if (isWhite) {
    //         data[i+1] = 255;
    //     }
    // }

    // convert segmentation to something we can use
    // array of 
    // {
    //      start: number
    //      end: number
    //      index: number
    // }
    // 
    var slices = segments.cols.reduce((slices, colValue, col) => {
        var last = slices[slices.length-1];
        var isWhite = colValue > 255; //1 bright white pixels minimum
        if (isWhite && !last.start) {
            last.start = col;
        }
        if (!isWhite && last.start) {
            last.end = col;
            last.width = last.end - last.start;
            slices.push({index: slices.length});
        }
        return slices;
    }, [{index: 0}]);

    imageData.data = data;
    return [imageData, slices];
}


// initialize a websocket interface to a local mhub-server
// to get one running locally
// `npm install -g mhub`
// `mhub-server`
//
// see https://github.com/poelstra/mhub for more info
//
// to see the data:
// `mhub-client`
function initWebSocket() {
    ws = new WebSocket('ws://localhost:13900');

    //subscribe to receive messages
    ws.onopen = function() {
        ws.send(JSON.stringify({
            type: 'subscribe',
            node: 'default'
        }));
    };

    //handle messages received
    ws.onmessage = function(msg) {
        // console.log(JSON.parse(msg.data));
    };

    //send messages
    return {
        send(topic, data) {
            ws.send(JSON.stringify({
                type: 'publish',
                node: 'default',
                data: data,
                topic: topic
            }));
        }
    }
}