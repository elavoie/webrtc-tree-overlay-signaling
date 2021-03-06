var http = require('http')
var ws = require('ws')
var debug = require('debug')
var log = debug('webrtc-bootstrap:server')
var express = require('express')
var crypto = require('crypto')
var url = require('url')

var HEARTBEAT_INTERVAL = 15000 // ms

var random = {
  seed: 49734321,
  next: function () {
    // Robert Jenkins' 32 bit integer hash function.
    random.seed = ((random.seed + 0x7ed55d16) + (random.seed << 12)) & 0xffffffff
    random.seed = ((random.seed ^ 0xc761c23c) ^ (random.seed >>> 19)) & 0xffffffff
    random.seed = ((random.seed + 0x165667b1) + (random.seed << 5)) & 0xffffffff
    random.seed = ((random.seed + 0xd3a2646c) ^ (random.seed << 9)) & 0xffffffff
    random.seed = ((random.seed + 0xfd7046c5) + (random.seed << 3)) & 0xffffffff
    random.seed = ((random.seed ^ 0xb55a4f09) ^ (random.seed >>> 16)) & 0xffffffff
    return random.seed
  }
}

function Server (secret, opts) {
  secret = secret || process.env.SECRET
  opts = (typeof opts) === 'object' ? opts : {}
  opts.public = opts.public || null
  opts.timeout = opts.timeout || 30 * 1000

  var root = null
  var prospects = this.prospects = {}
  this._upgraders = []

  if (!secret) {
    throw new Error('Invalid secret: ' + secret)
  }

  if (opts.seed) {
    random.seed = Number(opts.seed)
  }

  if (!opts.httpServer) {
    var app = express()
    if (opts.public) {
      log('serving files over http at ' + opts.public)
      app.use(express.static(opts.public))
    }
    var port = opts.port || process.env.PORT || 5000
    this.httpServer = http.createServer(app)
    this.httpServer.listen(port)
    log('http server listening on %d', port)
  } else {
    this.httpServer = opts.httpServer
  }

  function closeProspect (id) {
    if (prospects[id]) prospects[id].close()
  }

  function messageHandler (id) {
    return function incomingMessage (message) {
      message = JSON.parse(message)
      message.origin = id
      log('INCOMING MESSAGE')
      log(message)
      if (message.destination) {
        log('Destination defined')
        if (prospects.hasOwnProperty(message.destination)) {
          log('Known destination ' + message.destination)
          prospects[message.destination].send(JSON.stringify(message), function (err) {
            if (err) closeProspect(message.destination)
          })
        } else {
          log('Unknown destination ' + message.destination + ', ignoring message')
        }
      } else {
        if (root && root.readyState === ws.OPEN) {
          root.send(JSON.stringify(message))
        } else {
          if (!root) {
            log('WARNING: ignoring message because no root is connected')
          } else if (root.readyState !== ws.OPEN) {
            log('WARNING: ignoring message because root WebSocket channel is not open') 
          }
        }
      }
    }
  }

  log('Opening websocket connection for root on ' + secret)

  var server = this.server = new ws.Server({ noServer: true })
    .on('connection', function (ws) {
      function remove () {
        log('node ' + id + ' disconnected')
        delete prospects[id]
        clearTimeout(timeout)
      }
      var id = null

      if (opts.seed) {
        id = crypto.createHash('md5').update(random.next().toString()).digest().hexSlice(0, 16)
      } else {
        id = crypto.randomBytes(16).hexSlice()
      }
      ws.id = id
      log('node connected with id ' + id)
      ws.on('message', messageHandler(id))
      ws.on('close', remove)
      prospects[id] = ws
      var timeout = setTimeout(function () {
        closeProspect(id)
      }, opts.timeout)
    })

  var that = this
  this.httpServer.on('upgrade', function upgrade(request, socket, head) {
    const pathname = url.parse(request.url).pathname;
    log('httpServer url: ' + request.url + ', pathname: ' + pathname)
    for (var i = 0; i < that._upgraders.length; ++i) {
      var upgrader = that._upgraders[i]
      if (pathname === upgrader.path) {
        log("upgrading connection to '" + upgrader.path + "'")
        upgrader.wsServer.handleUpgrade(request, socket, head, function done(ws) {
          log("upgraded connection to '" + upgrader.path + "'")
          upgrader.wsServer.emit('connection', ws, request);
        });
        return
      } 
    }

    // No upgrader found
    socket.destroy();
  })

  this.upgrade('/' + secret + '/webrtc-bootstrap-root', function (ws) {
    log('root connected')
    var interval = null
    ws.on('message', function (data) {
      if (JSON.parse(data) === 'heartbeat') {
        log('root heartbeat')
      } else {
        log('WARNING: unexpected message from root: ' + data)
      }
    })
    ws.on('close', function () {
      log('root closed')
      clearInterval(interval)
    })
    ws.on('error', function (err) {
      log('ERROR: root failed with error:  ' + err)
      clearInterval(interval)
    })
    root = ws
    interval = setInterval(function () {
      ws.send(JSON.stringify('heartbeat'))
    }, HEARTBEAT_INTERVAL)
  })

  this.upgrade('/join', function (ws) {
    function remove () {
      log('node ' + id + ' disconnected')
      delete prospects[id]
      clearTimeout(timeout)
    }
    var id = null

    if (opts.seed) {
      id = crypto.createHash('md5').update(random.next().toString()).digest().hexSlice(0, 16)
    } else {
      id = crypto.randomBytes(16).hexSlice()
    }
    ws.id = id
    log('node connected with id ' + id)
    ws.on('message', messageHandler(id))
    ws.on('close', remove)
    prospects[id] = ws
    var timeout = setTimeout(function () {
      closeProspect(id)
    }, opts.timeout)
  })

  return this
}

// Handles websocket upgrades
//
// path: String (URL, ex: '/volunteer')
// handler: Function (ws, request) {}
Server.prototype.upgrade = function (path, handler) {
  var wsServer = new ws.Server({ noServer: true })
    .on('connection', handler) 
  this._upgraders.push({ path: path, wsServer: wsServer })
  return this
}

Server.prototype.close = function () {
  log('closing ws servers')
  for (var i = 0; i < this._upgraders.length; ++i) {
    this._upgraders[i].wsServer.close()
  }
  this._upgraders = []
  log('closing http server')
  this.httpServer.close()
  log('closing all prospects')
  for (var p in this.prospects) {
    log(this.prospects[p].close)
    this.prospects[p].close()
  }
}

module.exports = Server
