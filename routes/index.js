var http = require('request');
var cors = require('cors');
var uuid = require('uuid');
var url = require('url');

var redis = require('redis');
var client;
var env = process.env.NODE_ENV || 'dev';
if (env == 'dev') {
    client = redis.createClient();
} else {
    client = redis.createClient(process.env.REDIS_URL);
}

client.on('connect', function() {
    console.log("connected to redis");
});

var fs = require('fs');
var request = require('request');
var cheerio = require('cheerio');
var CircularBuffer = require("circular-buffer");
var parseDuration = require('parse-duration');

var lastStatus;
var statuses = new CircularBuffer(3);
var intervals = {};
var REFRESH_RATE = 10 * 1000; // 10 seconds
var VERSION = "6.0.0";
var USE_CROWD = false;
var MY_ID = process.env.MY_ID;

// This is the heart of your HipChat Connect add-on. For more information,
// take a look at https://developer.atlassian.com/hipchat/tutorials/getting-started-with-atlassian-connect-express-node-js
module.exports = function (app, addon) {
    var hipchat = require('../lib/hipchat')(addon);

    // simple healthcheck
    app.get('/healthcheck', function (req, res) {
        res.send('OK');
    });

    // Root route. This route will serve the `addon.json` unless a homepage URL is
    // specified in `addon.json`.
    app.get('/',
        function (req, res) {
            // Use content-type negotiation to choose the best way to respond
            res.format({
                // If the request content-type is text-html, it will decide which to serve up
                'text/html': function () {
                    var homepage = url.parse(addon.descriptor.links.homepage);
                    if (homepage.hostname === req.hostname && homepage.path === req.path) {
                        res.render('homepage', addon.descriptor);
                    } else {
                        res.redirect(addon.descriptor.links.homepage);
                    }
                },
                // This logic is here to make sure that the `addon.json` is always
                // served up when requested by the host
                'application/json': function () {
                    res.redirect('/atlassian-connect.json');
                }
            });
        }
    );

    // This is an example route that's used by the default for the configuration page
    // https://developer.atlassian.com/hipchat/guide/configuration-page
    app.get('/config',
        // Authenticates the request using the JWT token in the request
        addon.authenticate(),
        function (req, res) {
            // The `addon.authenticate()` middleware populates the following:
            // * req.clientInfo: useful information about the add-on client such as the
            //   clientKey, oauth info, and HipChat account info
            // * req.context: contains the context data accompanying the request like
            //   the roomId
            res.render('config', req.context);
        }
    );

    // This is an example glance that shows in the sidebar
    // https://developer.atlassian.com/hipchat/guide/glances
    app.get('/glance',
        cors(),
        addon.authenticate(),
        function (req, res) {
            console.log("/glance");
            url = 'http://cmmcd.com/PokemonGo/';
            request(url, function (error, response, text) {
                if (!error) {
                    var $ = cheerio.load(text);
                    var status;
                    $('.jumbotron table tr td h2').filter(function () {
                        var data = $(this);
                        text = data.text();
                        status = data.children().first().text();

                        var type;
                        if (status.includes("Online")) {
                            type = "success";
                        } else if (status.includes("Unstable")) {
                            type = "current";
                        } else {
                            type = "error";
                        }
                        res.json({
                            "label": {
                                "type": "html",
                                "value": "PoGo Server Is "
                            },
                            "status": {
                                "type": "lozenge",
                                "value": {
                                    "label": status,
                                    "type": type
                                }
                            }
                        });
                    });
                }
            });
        }
    );

    function updateGlance(req, status, text) {
        console.log("update glance to " + status);
        var type;
        if (status.includes("Online")) {
            type = "success";
        } else if (status.includes("Unstable")) {
            type = "current";
        } else {
            type = "error";
        }
        var clientId = req.body.oauth_client_id;
        var roomId = req.body.item.room.id;
        hipchat.sendGlance(clientId, roomId,"serverStatus.glance", {
            "label": {
                "type": "html",
                "value": "PoGo Server Is "
            },
            "status": {
                "type": "lozenge",
                "value": {
                    "label": status,
                    "type": type
                }
            }
        });
    }

    // This is an example route to handle an incoming webhook
    // https://developer.atlassian.com/hipchat/guide/webhooks
    app.post('/webhook',
        addon.authenticate(),
        function (req, res) {
            // console.log(req.body);
            var clientId = req.body.oauth_client_id;
            var room = req.body.item.room;
            //addon.settings.set(room.id, {version: VERSION, pings: [], muted: []}, clientId);
            console.log(req.body.item.message.message);
            //client.del("rooms", function(err, reply) {});

            hipchat.sendMessage(req.clientInfo, req.identity.roomId, 'pong pong')
                .then(function (data) {
                    res.sendStatus(200);
                });
        }
    );

    app.post('/help',
        addon.authenticate(),
        function (req, res) {
            helpString = "<b>/server</b>: Checks the server status. It will send a message to the room with the status of the pokemon go server. It will ping people on the subscriber list if the status changes.<br>" +
                "<b>/help</b>, <b>/h</b>: shows you what the commands do<br/>" +
                "<b>/subs</b>: Displays the ping names of people who will receive notification if the server status changes<br/>" +
                "<b>/add</b>: adds yourself to the subscriber list<br/>" +
                "<b>/remove</b>: removes yourself from the subscriber list<br/>" +
                "<b>/start</b>: starts listening for server status changes<br/>" +
                "<b>/stop</b>: stops listening for server status changes<br/>" +
                "<b>/version</b>, <b>/v</b>: lists the version of the bot in the form 'major.minor.patch'. If the major numbers are different, you need to uninstall and reinstall the bot to get the latest features<br/>" +
                "<b>/mute</b>: unsubscribes you for the time specified (/mute 20 s, /mute 30 minutes )<br/>" +
                "<b>/mutes</b>: displays the people who have muted and how much longer they have left<br/>";
            sendMessage(req, helpString);
            res.sendStatus(200);
        }
    );

    app.post('/server',
        addon.authenticate(),
        function (req, res) {
            checkServer(req, function (status, text) {
                sendMessage(req, text);
                lastStatus = status;
                statuses.enq(status);
                res.sendStatus(200);
            });
        }
    );

    app.post('/add',
        addon.authenticate(),
        function (req, res) {
            var user = req.body.item.message.from;

            addUser(req, user, function (added) {
                if (added) {
                    sendMessage(req, "added " + user.name + " to subscriber list");
                } else {
                    sendMessage(req, user.name + " is already subscribed");
                }
                res.sendStatus(200);
            });
        }
    );

    app.post('/remove',
        addon.authenticate(),
        function (req, res) {
            var user = req.body.item.message.from;

            removeUser(req, user, function (removed) {
                if (removed) {
                    sendMessage(req, user.name + " has unsubscribed :(");
                } else {
                    sendMessage(req, user.name + " wasn't subscribed");
                }
                res.sendStatus(200);
            });
        }
    );

    app.post('/subs',
        addon.authenticate(),
        function (req, res) {
            getMentions(req, function (names) {
                if (names.length > 0) {
                    var message = "current subs are (ping names): ";
                    names.forEach(function (name) {
                        message += " " + name;
                    });
                    sendMessage(req, message);
                } else {
                    sendMessage(req, "There are no subscribers :(");
                }
                res.sendStatus(200);
            });
        }
    );

    app.post('/start',
        addon.authenticate(),
        function (req, res) {
            getInterval(req, function (interval) {
                if (!interval) {
                    startInterval(req);
                    sendMessage(req, "I'll let you know if the server status changes");
                } else {
                    sendMessage(req, "I'm already listening for server changes");
                }
                res.sendStatus(200);
            });
        }
    );

    app.post('/stop',
        addon.authenticate(),
        function (req, res) {
            getInterval(req, function (interval) {
                if (interval) {
                    removeInterval(req, interval);
                    sendMessage(req, "I'm not listening for server changes anymore");
                } else {
                    sendMessage(req, "I'm not listening for server changes");
                }
                res.sendStatus(200);
            });
        }
    );

    app.post('/version',
        addon.authenticate(),
        function (req, res) {
            checkVersion(req, function (installedVersion, needUpgrade) {
                if (needUpgrade) {
                    sendMessage(req, installedVersion + " you need to upgrade, latest version is " + VERSION);
                } else {
                    sendMessage(req, VERSION + " (up to date)");
                }
                res.sendStatus(200);
            });
        }
    );

    app.post('/mute',
        addon.authenticate(),
        function (req, res) {
            addMute(req, function (user, time) {
                if (time) {
                    sendMessage(req, "muted " + user.name + " for " + timeConversion(time));
                } else {
                    sendMessage(req, user.name + " is not getting notifications");
                }
                res.sendStatus(200);
            });
        }
    );

    app.post('/mutes',
        addon.authenticate(),
        function (req, res) {
            getMutesString(req, function (mutesString) {
                sendMessage(req, mutesString);
                res.sendStatus(200);
            });
        }
    );

    app.post('/rooms',
        addon.authenticate(),
        function (req, res) {
            console.log(addon.settings.client);
            if (MY_ID == req.body.item.message.from.id) {
                getInstalledRooms(req, function (roomNames) {
                    //var roomNames = rooms.map(function(room) {return room.name});
                    sendMessage(req, "number of rooms: " + roomNames.length + "<br/>" + roomNames);
                    res.sendStatus(200);
                });
            } else {
                res.sendStatus(200);
            }
        }
    );

    function getInstalledRooms(req, callback = function(rooms) {}) {
        client.smembers('rooms', function(err, rooms) {
            callback(rooms);
        });
    }

    function checkVersion(req, callback = function (installedVersion, needUpgrade) {}) {
        getData(req, function (data) {
            callback(data.version, needUpgrade(data.version));
        });
    }

    function needUpgrade(installedVersion) {
        var installedMajor = parseInt(installedVersion.split(".")[0]);
        var major = parseInt(VERSION.split(".")[0]);
        return installedMajor < major;
    }

    function startInterval(req) {
        var room = req.body.item.room;
        console.log("starting interval for room " + room.name);
        clearStatuses();
        var first = true;
        interval = setInterval(function () {
            checkServer(req, function (status, text) {
                if (first) {
                    getMentionsString(req, function (pings) {
                        lastStatus = status;
                        sendMessage(req, text + pings, {options: {notify: true, format: "text"}});
                    });
                    first = false;
                } else if (status.includes("Offline") || status.includes("Unstable")) {
                    if (status.includes("Unstable") && !seenStatusRecently("Unstable")) {
                        getMentionsString(req, function (pings) {
                            lastStatus = status;
                            sendMessage(req, text + pings, {options: {notify: true, format: "text"}});
                        });
                    } else if (status.includes("Offline")) {
                        if (allStatusRecently("Offline") && !lastStatus.includes("Offline")) {
                            getMentionsString(req, function (pings) {
                                lastStatus = status;
                                sendMessage(req, text + pings, {options: {notify: true, format: "text"}});
                            });
                        }
                        if (!seenStatusRecently("Offline") && !lastStatus.includes("Unstable")) {
                            getMentionsString(req, function (pings) {
                                lastStatus = "Unstable";
                                sendMessage(req, text.replace("Offline", "Unstable") + pings, {options: {notify: true, format: "text"}});
                            });
                        }
                    }
                } else if (status.includes("Online")) {
                    if (!allStatusRecently("Online")) {
                        clearStatuses();
                        getMentionsString(req, function (pings) {
                            lastStatus = status;
                            sendMessage(req, text + pings, {options: {notify: true, format: "text"}});
                        });
                    }
                }
                statuses.enq(status);
            });
        }, REFRESH_RATE);
        storeInterval(req, interval);
    }

    function storeInterval(req, interval) {
        var clientId = req.body.oauth_client_id;
        var roomId = req.body.item.room.id;
        intervals[clientId] = intervals[clientId] || {};
        intervals[clientId][roomId] = interval;
        clearStatuses();
    }

    function removeInterval(req, interval) {
        var clientId = req.body.oauth_client_id;
        var room = req.body.item.room;
        clearInterval(interval);
        console.log("stopping interval for room " + room.name);
        intervals[clientId][room.id] = false;
    }

    function getInterval(req, callback = function (interval) {}) {
        var clientId = req.body.oauth_client_id;
        var roomId = req.body.item.room.id;
        callback(intervals[clientId] && intervals[clientId][roomId]);
    }

    function clearStatuses() {
        while (statuses.size() > 0) {
            statuses.deq();
        }
    }

    function allStatusRecently(statusString) {
        if (statuses.size() == 0) {
            return false
        }
        var arr = statuses.toarray();
        for (var i in arr) {
            var status = arr[i];
            if (!status.includes(statusString)) {
                return false;
            }
        }
        return true;
    }

    function seenStatusRecently(statusString) {
        var arr = statuses.toarray();
        for (var i in arr) {
            var status = arr[i];
            if (status.includes(statusString)) {
                return true;
            }
        }
        return false;
    }

    function getMentionsString(req, callback) {
        checkMuted(req, function () {
            getData(req, function (data) {
                var mentionNames = "";
                data.pings.forEach(function (user) {
                    mentionNames += " @" + user.mention_name;
                });

                callback(mentionNames);
            });
        });
    }

    function getMentions(req, callback) {
        checkMuted(req, function () {
            getData(req, function (data) {
                var mentionNames = [];
                data.pings.forEach(function (user) {
                    mentionNames.push(user.mention_name);
                });

                callback(mentionNames);
            });
        });
    }

    function getMutesString(req, callback = function (mutesString) {}) {
        checkMuted(req, function () {
            getData(req, function (data) {
                var now = new Date();
                var mutesString = "";
                if (data.muted.length > 0) {
                    for (var mute of data.muted) {
                        mutesString += mute.user.name;
                        mutesString += ": ";
                        mutesString += timeConversion(new Date(mute.endTime) - now);
                        mutesString += "<br/>\n";
                    }
                } else {
                    mutesString = "No one is currently being muted";
                }
                callback(mutesString);
            });
        });
    }

    function addMute(req, callback = function (user, time) {}) {
        var user = req.body.item.message.from;
        var time = parseDuration(req.body.item.message.message);
        var endTime = new Date(new Date().getTime() + time);
        var found = false;
        getData(req, function (data) {
            for (var index in data.muted) {
                var muted = data.muted[index];
                if (muted.user.id == user.id) {
                    muted.endTime = endTime.getTime();
                    found = true;
                    setData(req, data);
                    callback(user, time);
                    return;
                }
            }
            var userIndex;
            if (!found) {
                if ((userIndex = includesUser(data.pings, user))) {
                    data.pings.splice(userIndex, 1);
                    data.muted.push({user: user, endTime: endTime.getTime()});
                    setData(req, data);
                    callback(user, time);
                } else {
                    callback(user, false);
                }
            }
        });

    }

    function checkMuted(req, callback = function () {}) {
        var currentTime = new Date();
        getData(req, function (data) {
            for (var index in data.muted) {
                var muted = data.muted[index];
                var user = muted.user;
                if (muted.endTime < currentTime) {
                    data.muted.splice(index, 1);
                    if (!includesUser(data.pings, user)) {
                        data.pings.push(user);
                    }
                }
            }
            setData(req, data);
            callback();
        });
    }

    function addUser(req, user, callback = function (added) {}) {
        getData(req, function (data) {
            if (!includesUser(data.pings, user)) {
                data.pings.push(user);
                setData(req, data);
                callback(true);
            } else {
                callback(false)
            }
        });
    }

    function removeUser(req, user, callback = function () {}) {
        getData(req, function (data) {
            var index;
            if (index = includesUser(data.pings, user)) {
                data.pings.splice(index, 1);
                setData(req, data);
                callback(user);
            } else {
                callback(false)
            }
        });
    }

    function includesUser(arr, user) {
        for (var index in arr) {
            var storedUser = arr[index];
            if (storedUser.id == user.id) {
                return index;
            }
        }
        return false;
    }

    function sendMessage(req, message, ops = {}) {
        checkVersion(req, function (installedVersion, needUpgrade) {
            console.log("here");
            if (needUpgrade) {
                hipchat.sendMessage(req.clientInfo, req.identity.roomId, "You need to upgrade this plugin by uninstalling and reinstalling the plugin here: https://marketplace.atlassian.com/plugins/pokemon-go-server-status-bot/cloud/overview", {options: {format: "text"}});
            }
            hipchat.sendMessage(req.clientInfo, req.identity.roomId, message, ops);
        });
    }

    function checkServer(req, callback = function (status, text) {}) {
        if (USE_CROWD) {
            var url = 'http://cmmcd.com/PokemonGo/';
            request(url, function (error, response, text) {
                if (!error) {
                    var $ = cheerio.load(text);
                    $('.jumbotron table tr td h2').filter(function () {
                        var data = $(this);
                        var text = data.text();
                        var status = data.children().first().text();

                        console.log("check crowd server: " + text);
                        updateGlance(req, status, text);
                        callback(status, text);
                    });
                }
            });
        } else {
            var url = 'http://www.mmoserverstatus.com/pokemon_go';
            request(url, function (error, response, text) {
                if (!error) {
                    var $ = cheerio.load(text);
                    $('.counter ul').filter(function () {
                        var data = $(this);
                        var i = data.children().last().children().first().children().first();
                        var status = "";
                        var text = "";
                        if (i.hasClass('fa fa-check green')) {
                            status = "Online!";
                            text = 'Pokémon Go Server Status: Online!'
                        } else {
                            status = "Offline!";
                            text = 'Pokémon Go Server Status: Offline! (or very unstable)'
                        }

                        console.log("check non crowd server: " + text);
                        updateGlance(req, status, text);
                        callback(status, text);
                    });
                }
            });
        }
    }

    function getData(req, callback = function (data) {}) {
        var clientId = req.body.oauth_client_id;
        var roomId = req.body.item.room.id;
        addon.settings.get(roomId, clientId).then(function (data) {
            callback(data);
        });
    }

    function setData(req, data) {
        var clientId = req.body.oauth_client_id;
        var roomId = req.body.item.room.id;
        addon.settings.set(roomId, data, clientId);
    }

// Notify the room that the add-on was installed. To learn more about
// Connect's install flow, check out:
// https://developer.atlassian.com/hipchat/guide/installation-flow
    addon.on('installed', function (clientKey, clientInfo, req) {
        var clientId = req.body.oauthId;
        var roomId = req.body.roomId;
        intervals[clientId] = intervals[clientId] || {};
        intervals[clientId][roomId] = intervals[clientId][roomId] || false;
        addon.settings.get(roomId, clientId).then(function (data) {
            data = {version: VERSION, pings: [], muted: []};
            addon.settings.set(roomId, data, clientId);
        });
        hipchat.getRoom(clientInfo, roomId).then(function(res) {
            if (res.statusCode == 200) {
                addRoom(res.body);
            }
            hipchat.sendMessage(clientInfo, roomId, 'The ' + addon.descriptor.name + ' add-on has been installed in this room').then(function (data) {
                hipchat.sendMessage(clientInfo, roomId, "use /help to find out what I do");
            });
        });
        checkServer({body: {oauth_client_id: clientId, item: {room: {id: roomId}}}}, function (status, text) {
            lastStatus = status;
        });
    });

// Clean up clients when uninstalled
    addon.on('uninstalled', function (id) {
        // #TODO remove room from list of rooms
        addon.settings.client.keys(id + ':*', function (err, rep) {
            rep.forEach(function (k) {
                addon.logger.info('Removing key:', k);
                addon.settings.client.del(k);
            });
        });
    });
};

function addRoom(room) {
    client.sadd(["rooms", room.name], function(err, reply) {
        if (err) {
            console.log(err);
        } else {
            console.log(reply);
        }
    });
}

String.prototype.replaceAll = function (search, replacement) {
    var target = this;
    return target.replace(new RegExp(search, 'g'), replacement);
};

function timeConversion(millisec) {
    var seconds = (millisec / 1000).toFixed(2);
    var minutes = (millisec / (1000 * 60)).toFixed(2);
    var hours = (millisec / (1000 * 60 * 60)).toFixed(2);
    var days = (millisec / (1000 * 60 * 60 * 24)).toFixed(2);

    if (seconds < 60) {
        return seconds + " Seconds";
    } else if (minutes < 60) {
        return minutes + " Minutes";
    } else if (hours < 24) {
        return hours + " Hours";
    } else {
        return days + " Days"
    }
}
