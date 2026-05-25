const WebSocket = require('ws');

const WebSocketAddress = 'wss://api.chilloutvr.net/1/users/ws';

const log = require('./logger').GetLogger('API_WS');

const events = require('events');
const Utils = require('./utils');

// // Test websocket server start
// if (process.env.TEST_WS_SERVER === 'true' && !require('electron').app.isPackaged) {
//     log.warn('Initializing testing websocket server...');
//     require('./ws_fake.test');
//     log.warn('Setting websocket url to localhost...');
//     WebSocketAddress = 'ws://localhost';
// }

const EventEmitter = new events.EventEmitter();
exports.EventEmitter = EventEmitter;

const MaxReconnectionAttempts = 5;

let currentUsername;
let currentAccessKey;

let previousSocket;

const SOCKET_EVENTS = Object.freeze({
    CONNECTED: Symbol(),
    DEAD: Symbol(),
    RECONNECTION_FAILED: Symbol(),
});
exports.SocketEvents = SOCKET_EVENTS;

const RESPONSE_TYPE = Object.freeze({
    MENU_POPUP: 0,
    HUD_MESSAGE: 1,
    ONLINE_FRIENDS: 10,
    FRIEND_LIST_UPDATED: 11,
    INVITES: 15,
    REQUEST_INVITES: 20,
    FRIEND_REQUESTS: 25,
    MATURE_CONTENT_UPDATE: 30,
    GROUP_INVITE: 50,
});
exports.ResponseType = RESPONSE_TYPE;
const GetResponseTypeName = (value) => Object.keys(RESPONSE_TYPE).find(key => RESPONSE_TYPE[key] === value);


// API Entity Mappings
function preProcessEntities(responseType, data) {
    switch (responseType) {
        case RESPONSE_TYPE.ONLINE_FRIENDS: return Utils.MapEntity(data, MAP_FRIEND);
        case RESPONSE_TYPE.INVITES: return Utils.MapEntity(data, MAP_INVITE);
        case RESPONSE_TYPE.REQUEST_INVITES: return Utils.MapEntity(data, MAP_REQUEST_INVITE);
        case RESPONSE_TYPE.FRIEND_REQUESTS: return Utils.MapEntity(data, MAP_USER);
        case RESPONSE_TYPE.MATURE_CONTENT_UPDATE: return Utils.MapEntity(data, MAP_MATURE_CONTENT_UPDATE);
    }
    return data;
}

const MAP_INSTANCE = Object.freeze({
    'Id': 'id',
    'Name': 'name',
    'Privacy': 'privacy',
});

const MAP_FRIEND = Object.freeze({
    'Id': 'id',
    'IsOnline': 'isOnline',
    'IsConnected': 'isConnected',
    'Instance': {
        root: 'instance',
        mapping: MAP_INSTANCE,
    },
});

const MAP_USER = Object.freeze({
    'Id': 'id',
    'Name': 'name',
    'ImageUrl': 'imageUrl',
});

const MAP_WORLD = Object.freeze({
    'Id': 'id',
    'Name': 'name',
    'ImageUrl': 'imageUrl',
});

const MAP_INVITE = Object.freeze({
    'Id': 'id',
    'User': {
        root: 'user',
        mapping: MAP_USER,
    },
    'World': {
        root: 'world',
        mapping: MAP_WORLD,
    },
    'InstanceId': 'instanceId',
    'InstanceName': 'instanceName',
    'ReceiverId': 'receiverId',
});

const MAP_REQUEST_INVITE = Object.freeze({
    'Id': 'id',
    'Sender': {
        root: 'sender',
        mapping: MAP_USER,
    },
    'ReceiverId': 'receiverId',
});

const MAP_MATURE_CONTENT_UPDATE = Object.freeze({
    'Unlocked': 'unlocked',
    'Enabled': 'enabled',
    'Terminated': 'terminated',
});

exports.MapMatureContentConfig = (config) => Utils.MapEntity(config, MAP_MATURE_CONTENT_UPDATE);


const heartbeatInterval = 60 * 1000;
const missedPongsTimeout = 5;
let heartbeatTimeout;
function heartbeat(socket) {
    // The server will send a pong every 60 seconds, if there's no pong within 5 minutes let's nuke the socket
    clearTimeout(heartbeatTimeout);
    heartbeatTimeout = setTimeout(async () => {
        log.warn(`[Heartbeat] {${socket.uniqueId}} timed out... Closing socket...`);
        exports.DisconnectWebsocket(false);
    }, missedPongsTimeout * heartbeatInterval);
}


function Wait5Seconds() {
    return new Promise((resolve) => {
        setTimeout(resolve, 5000);
    });
}


// Adaptive per-response-type coalescer. A reconnect storm can fan one WS
// reconnect into a flurry of identical state messages, each of which triggers
// renderer IPC, HTTP refetches, and image-cache work downstream. Under normal
// load this passes messages straight through. When a single type crosses the
// burst threshold, subsequent messages of that type are buffered and only the
// latest payload is emitted on a fixed flush cadence, until the rate drops
// back below threshold.
//
// Per-type rather than global because:
//   - Bursts are dominated by snapshot-style messages (ONLINE_FRIENDS etc.)
//     where keeping just the latest payload is acceptable.
//   - Toast-style messages (MENU_POPUP, HUD_MESSAGE) are one-shot user
//     messages and should never be dropped, so they're exempted.
//
// NOTE: ONLINE_FRIENDS / INVITES / REQUEST_INVITES / FRIEND_REQUESTS payloads
// are partial snapshots — coalescing drops intermediate per-id updates during
// a burst. That's an acceptable trade against crashing under load; if those
// payloads ever become strict deltas, this needs revisiting.
const COALESCE_WINDOW_MS = 1000;
const COALESCE_THRESHOLD = 5;
const COALESCE_FLUSH_MS = 200;

const COALESCE_EXEMPT_TYPES = new Set([
    RESPONSE_TYPE.MENU_POPUP,
    RESPONSE_TYPE.HUD_MESSAGE,
]);

const coalesceState = new Map();

function getCoalesceState(responseType) {
    let state = coalesceState.get(responseType);
    if (!state) {
        state = {
            timestamps: [],
            pendingData: null,
            pendingMessage: null,
            flushTimer: null,
            coalescing: false,
        };
        coalesceState.set(responseType, state);
    }
    return state;
}

function trimWindow(timestamps, now) {
    while (timestamps.length > 0 && timestamps[0] < now - COALESCE_WINDOW_MS) {
        timestamps.shift();
    }
}

function flushCoalesce(responseType) {
    const state = coalesceState.get(responseType);
    if (!state) return;
    state.flushTimer = null;

    if (state.pendingData !== null || state.pendingMessage !== null) {
        EventEmitter.emit(responseType, state.pendingData, state.pendingMessage);
        state.pendingData = null;
        state.pendingMessage = null;
    }

    trimWindow(state.timestamps, Date.now());

    if (state.timestamps.length >= COALESCE_THRESHOLD) {
        state.flushTimer = setTimeout(() => flushCoalesce(responseType), COALESCE_FLUSH_MS);
    } else {
        log.info(`[Coalesce] Disengaging for ${GetResponseTypeName(responseType)} (${responseType}) — rate fell below ${COALESCE_THRESHOLD}/${COALESCE_WINDOW_MS}ms`);
        state.coalescing = false;
    }
}

function dispatchMessage(responseType, processedData, message) {
    // HTML-escape every string before fanning out to listeners — this is the
    // WS-side chokepoint that mirrors the one in api_cvr_http.js. Anything
    // downstream can render the data via innerHTML without worrying about
    // smuggled markup.
    const escapedData = Utils.EscapeHtml(processedData);
    const escapedMessage = Utils.EscapeHtml(message);

    if (COALESCE_EXEMPT_TYPES.has(responseType)) {
        EventEmitter.emit(responseType, escapedData, escapedMessage);
        return;
    }

    const state = getCoalesceState(responseType);
    const now = Date.now();
    state.timestamps.push(now);
    trimWindow(state.timestamps, now);

    if (!state.coalescing && state.timestamps.length >= COALESCE_THRESHOLD) {
        state.coalescing = true;
        log.warn(`[Coalesce] Engaging for ${GetResponseTypeName(responseType)} (${responseType}) — ${state.timestamps.length} events in ${COALESCE_WINDOW_MS}ms, will keep latest payload only every ${COALESCE_FLUSH_MS}ms`);
    }

    if (!state.coalescing) {
        EventEmitter.emit(responseType, escapedData, escapedMessage);
        return;
    }

    state.pendingData = escapedData;
    state.pendingMessage = escapedMessage;
    if (!state.flushTimer) {
        state.flushTimer = setTimeout(() => flushCoalesce(responseType), COALESCE_FLUSH_MS);
    }
}

function resetCoalesceState() {
    for (const state of coalesceState.values()) {
        if (state.flushTimer) {
            clearTimeout(state.flushTimer);
            state.flushTimer = null;
        }
    }
    coalesceState.clear();
}


exports.ConnectWithCredentials = async (username, accessKey) => {

    // If we have a socket connected and the credentials changed, lets nuke it
    if ((username !== currentUsername || accessKey !== currentAccessKey) && previousSocket) {
        await exports.DisconnectWebsocket(true, 'The CVRX User is changing...');
    }

    ResetReconnectionInfo();

    currentUsername = username;
    currentAccessKey = accessKey;

    await ConnectWebsocket(username, accessKey);
};


function ResetReconnectionInfo() {
    // Clear previous connection stuff
    clearTimeout(reconnectTimeoutId);
    clearTimeout(heartbeatTimeout);
    reconnectCounter = 0;
}


let reconnectCounter = 0;
let reconnectTimeoutId;
exports.Reconnect = async (manualRetry = false) => {

    if (previousSocket && (previousSocket.readyState === WebSocket.OPEN || previousSocket.readyState === WebSocket.CONNECTING)) {
        const msg = 'The socket is already connected or connecting...';
        if (manualRetry) EventEmitter.emit(SOCKET_EVENTS.RECONNECTION_FAILED, msg);
        return;
    }

    if (!currentUsername || !currentAccessKey) {
        const msg = 'Missing current credentials... Close the CVRX and try again.';
        if (manualRetry) EventEmitter.emit(SOCKET_EVENTS.RECONNECTION_FAILED, msg);
        return;
    }

    if (manualRetry) ResetReconnectionInfo();

    reconnectCounter += 1;
    if (reconnectCounter > MaxReconnectionAttempts) {
        log.error(`[Reconnect] Failed to connect to CVR Websocket, attempted ${reconnectCounter - 1}/${MaxReconnectionAttempts} times! Giving up...`);
        EventEmitter.emit(SOCKET_EVENTS.DEAD);
        return;
    }
    else {
        log.warn(`[Reconnect] Attempting to connect to CVR Websocket, attempt: ${reconnectCounter}/${MaxReconnectionAttempts}`);
    }

    // If the last reconnection was 2 minutes ago, reset the reconnection counter
    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = setTimeout(() => {
        reconnectCounter = 0;
    }, 2 * 60 * 1000);

    try {
        await ConnectWebsocket(currentUsername, currentAccessKey);
    }
    catch (e) {
        log.error('[Reconnect] Error connecting to the Websocket...', e.toString(), e.message.toString());
        EventEmitter.emit(SOCKET_EVENTS.DEAD);
    }
};


exports.DisconnectWebsocket = (expectedClose = false, reason = '') => {
    if (previousSocket) {
        if (expectedClose) {
            previousSocket.close(1000, reason);
        }
        else {
            previousSocket.close();
        }
        log.info(`[DisconnectWebsocket] {${previousSocket.uniqueId}} The close request was initiated...`);
    }
};


let socketIdGenerator = 0;
function ConnectWebsocket(username, accessKey) {

    return new Promise((resolve, _reject) => {

        if (previousSocket) {
            if (previousSocket.readyState === WebSocket.OPEN || previousSocket.readyState === WebSocket.CONNECTING) {
                log.error(`[ConnectWebsocket] {${previousSocket.uniqueId}} The previous socket is still connected/connecting. readyState: ${previousSocket.readyState}`);
                resolve();
                return;
            }
            if (previousSocket.readyState === WebSocket.CLOSING || previousSocket.readyState === WebSocket.CLOSED) {
                log.warn(`[ConnectWebsocket] {${previousSocket.uniqueId}} There was a previous socket, but it was closed/closing. readyState: ${previousSocket.readyState}`);
            }
        }

        const socket = new WebSocket(WebSocketAddress, {
            perMessageDeflate: false,
            headers: {
                'Username': username,
                'AccessKey': accessKey,
                'User-Agent': Utils.GetUserAgent(),
                'Platform': 'pc_standalone',
                'CompatibleVersions': '0,1,2',
                'MatureContentDlc': 'false',
            },
        });

        socket.uniqueId = socketIdGenerator++;
        previousSocket = socket;

        socket.on('error', async (error) => {
            log.error(`[ConnectWebsocket] [onError] {${socket.uniqueId}}`, error);
        });

        socket.on('open', () => {
            log.info(`[ConnectWebsocket] [onOpen] {${socket.uniqueId}} Opened!`);
            EventEmitter.emit(SOCKET_EVENTS.CONNECTED);
            heartbeat(socket);
            resolve();
        });

        socket.on('ping', (data) => {
            log.verbose(`[ConnectWebsocket] [onPing] {${socket.uniqueId}} Received Ping`, data.toString());
        });
        socket.on('pong', (data) => {
            heartbeat(socket);
            log.verbose(`[ConnectWebsocket] [onPong] {${socket.uniqueId}} Received Pong`, data.toString());
        });
        socket.on('redirect', (url, _request) => {
            log.verbose(`[ConnectWebsocket] [onRedirect] {${socket.uniqueId}} Received Redirect Request: ${url}`);
        });
        socket.on('unexpected-response', (request, response) => {
            log.debug(`[ConnectWebsocket] [onUnexpectedResponse] {${socket.uniqueId}} Unexpected Response! Request Code: ${request.code}, Response Code: ${response.code}`);
        });
        socket.on('upgrade', (response) => {
            log.verbose(`[ConnectWebsocket] [onUpgrade] {${socket.uniqueId}} Upgrade: Response Code: ${response.code}`);
        });

        socket.on('close', async (code, reason) => {
            log.warn(`[ConnectWebsocket] [onClose] {${socket.uniqueId}} Closed! Code: ${code}, Reason: ${reason.toString()}`);
            previousSocket = null;
            // Drop any buffered coalesced payloads — on reconnect we'll get a
            // fresh snapshot anyway, and emitting stale data after the close
            // would race with the new connection.
            resetCoalesceState();

            // Only attempt to reconnect if the close code is one of the following:
            if (code === 1001 || code === 1005 || code === 1006) {
                log.info('[ConnectWebsocket] [onClose] Attempting to reconnect in 5 seconds...');
                await Wait5Seconds();
                await exports.Reconnect();
            }
        });

        socket.on('message', (messageBuffer, isBinary) => {

            // Ignore binary messages, but log them
            if (isBinary) {
                log.warn(`[ConnectWebsocket] [onMessage] {${socket.uniqueId}} Received Message in binary...`, messageBuffer?.toString());
                return;
            }

            // Attempt to parse json
            try {
                const { ResponseType: responseType, Message: message, Data: data } = JSON.parse(messageBuffer.toString());
                if (Object.values(RESPONSE_TYPE).includes(responseType)) {
                    const processedData = preProcessEntities(responseType, data);
                    // dispatchMessage applies the HTML-escape that used to be inline
                    // here, plus adaptive coalescing under burst load.
                    dispatchMessage(responseType, processedData, message);
                    const logObj = { 'API Original Data': data, 'CVRX Processed Data': processedData };
                    log.debug(`[ConnectWebsocket] [onMessage] {${socket.uniqueId}} Type: ${GetResponseTypeName(responseType)} (${responseType}), Msg: ${message}`, logObj);
                }
                else {
                    log.warn(`[ConnectWebsocket] [onMessage] {${socket.uniqueId}} Response type ${responseType} is not mapped! Msg: ${message}`, data);
                }
            } catch (e) {
                log.error(e);
                log.error(`[ConnectWebsocket] [onMessage] {${socket.uniqueId}} Failed to parse the base message. This could mean the API changed...`, messageBuffer?.toString());
            }
        });
    });
}

const RequestType = Object.freeze({
    FRIEND_REQUEST_SEND: 5,
    FRIEND_REQUEST_ACCEPT: 6,
    FRIEND_REQUEST_DECLINE: 7,
    UNFRIEND: 8,
    BLOCK_USER: 30,
    UNBLOCK_USER: 31,
});
const GetRequestName = (value) => Object.keys(RequestType).find(key => RequestType[key] === value);

function SendRequest(requestType, data) {
    if (!previousSocket || previousSocket.readyState !== WebSocket.OPEN) {
        log.error(`[SendRequest] Attempted to send a ${GetRequestName(requestType)} request while the socket was not Opened! readyState: ${previousSocket.readyState}`);
        return;
    }
    // Prepare the request json and send
    previousSocket.send(JSON.stringify({
        RequestType: requestType,
        Data: data,
    }));
}

// Friendship
exports.SendFriendRequest = async (userId) => SendRequest(RequestType.FRIEND_REQUEST_SEND, {id: userId});
exports.AcceptFriendRequest = async (userId) => SendRequest(RequestType.FRIEND_REQUEST_ACCEPT, {id: userId});
exports.DeclineFriendRequest = async (userId) => SendRequest(RequestType.FRIEND_REQUEST_DECLINE, {id: userId});
exports.Unfriend = async (userId) => SendRequest(RequestType.UNFRIEND, {id: userId});

// Moderation
exports.BlockUser = async (userId) => SendRequest(RequestType.BLOCK_USER, {id: userId});
exports.UnblockUser = async (userId) => SendRequest(RequestType.UNBLOCK_USER, {id: userId});
