/**
 * Debugger Module for the Cloud9 IDE
 *
 * @copyright 2010, Ajax.org B.V.
 * @license GPLv3 <http://www.gnu.org/licenses/gpl.txt>
 */
var Path             = require("path"),
    Spawn            = require("child_process").spawn,
    NodeDebugProxy   = require("./nodedebugproxy"),
    ChromeDebugProxy = require("./chromedebugproxy"),
    Plugin           = require("cloud9/plugin"),
    sys              = require("sys"),
    netutil          = require("cloud9/netutil");

var DebuggerPlugin = module.exports = function(ide, workspace) {
    Plugin.call(this, ide, workspace);
    this.hooks = ["command"];
    this.name = "debugger";
    this.nodeCmd = process.argv[0];
};

sys.inherits(DebuggerPlugin, Plugin);

(function() {
    this.NODE_DEBUG_PORT = 5858;
    this.CHROME_DEBUG_PORT = 9222;

    this.init = function() {
        var _self = this;
        this.workspace.getExt("state").on("statechange", function(state) {
            state.debugClient = !!_self.debugClient;
            state.processRunning = !!_self.child;
        });
    };

    this.command = function(user, message, client) {
        var _self = this;

        var cmd = (message.command || "").toLowerCase(),
            res = true;
        switch (cmd) {
            case "run":
                this.$run(message, client);
                break;
            case "rundebug":
                netutil.findFreePort(this.NODE_DEBUG_PORT, "localhost", function(port) {
                    _self.NODE_DEBUG_PORT = port;
                    message.preArgs = ["--debug=" + _self.NODE_DEBUG_PORT];
                    message.debug = true;
                    _self.$run(message, client);

                    setTimeout(function() {
                        _self.$startDebug();
                    }, 100);
                });
                break;
            case "rundebugbrk":
                netutil.findFreePort(this.NODE_DEBUG_PORT, "localhost", function(port) {
                    _self.NODE_DEBUG_PORT = port;

                    message.preArgs = ["--debug-brk=" + _self.NODE_DEBUG_PORT];
                    message.debug = true;
                    _self.$run(message, client);

                    setTimeout(function() {
                        _self.$startDebug();
                    }, 100);
                });
                break;
            case "rundebugchrome":
                if (this.chromeDebugProxy) {
                    this.error("Chrome debugger already running!", 7, message);
                    break;
                }
                this.chromeDebugProxy = new ChromeDebugProxy(this.CHROME_DEBUG_PORT);
                this.chromeDebugProxy.connect();

                this.chromeDebugProxy.addEventListener("connection", function() {
                    _self.send('{"type": "chrome-debug-ready"}', null, _self.name);
                });
                break;
            case "debugnode":
                if (!this.nodeDebugProxy)
                    this.error("No debug session running!", 6, message);
                else
                    this.nodeDebugProxy.send(message.body);
                break;
            case "debugattachnode":
                if (this.nodeDebugProxy)
                    this.send('{"type": "node-debug-ready"}', null, _self.name);
                break;
            case "kill":
                this.$kill();
                break;
            default:
                res = false;
                break;
        }
        return res;
    };

    this.$kill = function() {
        var child = this.child;
        if (!child)
            return;
        try {
            child.kill();
            // check after 2sec if the process is really dead
            // If not kill it harder
            setTimeout(function() {
                if (child.pid > 0)
                    child.kill("SIGKILL");
            }, 2000)
        }
        catch(e) {}
    };

    this.$run = function(message, client) {
        var _self = this;

        if (this.child)
            return _self.error("Child process already running!", 1, message);

        var file = _self.workspace.workspaceDir + "/" + message.file;

        Path.exists(file, function(exists) {
           if (!exists)
               return _self.error("File does not exist: " + message.file, 2, message);

           var cwd = _self.workspace.workspaceDir + "/" + (message.cwd || "");
           Path.exists(cwd, function(exists) {
               if (!exists)
                   return _self.error("cwd does not exist: " + message.cwd, 3, message);
                // lets check what we need to run
                if(file.match(/\.js$/)){
                   var args = (message.preArgs || []).concat(file).concat(message.args || []);
                   _self.$runProc(_self.nodeCmd, args, cwd, message.env || {}, message.debug || false);
                } else {
                   _self.$runProc(file, message.args||[], cwd, message.env || {}, false);
                }
           });
        });
    };

    this.$runProc = function(proc, args, cwd, env, debug) {
        var _self = this;
        var name = this.name;

        // mixin process env
        for (var key in process.env) {
            if (!(key in env))
                env[key] = process.env[key];
        }

        console.log("Executing node "+proc+" "+args.join(" ")+" "+cwd);

        var child = _self.child = Spawn(proc, args, {cwd: cwd, env: env});
        _self.debugClient = args.join(" ").search(/(?:^|\b)\-\-debug\b/) != -1;
        _self.workspace.getExt("state").publishState();
        _self.send({"type": "node-start"}, null, name);

        child.stdout.on("data", sender("stdout"));
        child.stderr.on("data", sender("stderr"));

        function sender(stream) {
            return function(data) {
                var message = {
                    "type": "node-data",
                    "stream": stream,
                    "data": data.toString("utf8")
                };
                _self.send(message, null, name);
            };
        }

        child.on("exit", function(code) {
            _self.send({"type": "node-exit"}, null, name);

            _self.debugClient = false;
            delete _self.child;
            delete _self.nodeDebugProxy;
        });

        return child;
    };

    this.$startDebug = function(message) {
        var _self = this;

        if (!this.debugClient)
            return this.error("No debuggable application running", 4, message);

        if (this.nodeDebugProxy)
            return this.error("Debug session already running", 5, message);

        this.nodeDebugProxy = new NodeDebugProxy(this.NODE_DEBUG_PORT);
        this.nodeDebugProxy.on("message", function(body) {
            var msg = {
                "type": "node-debug",
                "body": body
            };
            _self.send(msg, null, _self.name);
        });

        this.nodeDebugProxy.on("connection", function() {
            _self.send('{"type": "node-debug-ready"}', null, _self.name);
        });

        this.nodeDebugProxy.on("end", function() {
            if (_self.nodeDebugProxy == this) {
                delete _self.nodeDebugProxy;
            }
        });

        this.nodeDebugProxy.connect();
    };

    this.dispose = function(callback) {
        this.$kill();
        callback();
    };

}).call(DebuggerPlugin.prototype);
