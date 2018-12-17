"use strict";
/**
 * @fileoverview SessionDescriptionHandler
 */
/* SessionDescriptionHandler
 * @class PeerConnection helper Class.
 * @param {SIP.Session} session
 * @param {Object} [options]
 */
module.exports = function (SIP) {
    // Constructor
    var SessionDescriptionHandler = function (logger, observer, options) {
        // TODO: Validate the options
        this.options = options || {};
        this.logger = logger;
        this.observer = observer;
        this.dtmfSender = null;
        this.shouldAcquireMedia = true;
        this.CONTENT_TYPE = 'application/sdp';
        this.C = {};
        this.C.DIRECTION = {
            NULL: null,
            SENDRECV: "sendrecv",
            SENDONLY: "sendonly",
            RECVONLY: "recvonly",
            INACTIVE: "inactive"
        };
        this.logger.log('SessionDescriptionHandlerOptions: ' + JSON.stringify(this.options));
        this.direction = this.C.DIRECTION.NULL;
        this.modifiers = this.options.modifiers || [];
        if (!Array.isArray(this.modifiers)) {
            this.modifiers = [this.modifiers];
        }
        var environment = global.window || global;
        this.WebRTC = {
            MediaStream: environment.MediaStream,
            getUserMedia: environment.navigator.mediaDevices.getUserMedia.bind(environment.navigator.mediaDevices),
            RTCPeerConnection: environment.RTCPeerConnection
        };
        this.iceGatheringDeferred = null;
        this.iceGatheringTimeout = false;
        this.iceGatheringTimer = null;
        this.initPeerConnection(this.options.peerConnectionOptions);
        this.constraints = this.checkAndDefaultConstraints(this.options.constraints);
    };
    /**
     * @param {SIP.Session} session
     * @param {Object} [options]
     */
    SessionDescriptionHandler.defaultFactory = function defaultFactory(session, options) {
        var logger = session.ua.getLogger('sip.invitecontext.sessionDescriptionHandler', session.id);
        var SessionDescriptionHandlerObserver = require('./SessionDescriptionHandlerObserver');
        var observer = new SessionDescriptionHandlerObserver(session, options);
        return new SessionDescriptionHandler(logger, observer, options);
    };
    SessionDescriptionHandler.prototype = Object.create(SIP.SessionDescriptionHandler.prototype, {
        // Functions the sesssion can use
        /**
         * Destructor
         */
        close: { writable: true, value: function () {
                this.logger.log('closing PeerConnection');
                // have to check signalingState since this.close() gets called multiple times
                if (this.peerConnection && this.peerConnection.signalingState !== 'closed') {
                    if (this.peerConnection.getSenders) {
                        this.peerConnection.getSenders().forEach(function (sender) {
                            if (sender.track) {
                                sender.track.stop();
                            }
                        });
                    }
                    else {
                        this.logger.warn('Using getLocalStreams which is deprecated');
                        this.peerConnection.getLocalStreams().forEach(function (stream) {
                            stream.getTracks().forEach(function (track) {
                                track.stop();
                            });
                        });
                    }
                    if (this.peerConnection.getReceivers) {
                        this.peerConnection.getReceivers().forEach(function (receiver) {
                            if (receiver.track) {
                                receiver.track.stop();
                            }
                        });
                    }
                    else {
                        this.logger.warn('Using getRemoteStreams which is deprecated');
                        this.peerConnection.getRemoteStreams().forEach(function (stream) {
                            stream.getTracks().forEach(function (track) {
                                track.stop();
                            });
                        });
                    }
                    this.resetIceGatheringComplete();
                    this.peerConnection.close();
                }
            } },
        /**
         * Gets the local description from the underlying media implementation
         * @param {Object} [options] Options object to be used by getDescription
         * @param {MediaStreamConstraints} [options.constraints] MediaStreamConstraints https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamConstraints
         * @param {Object} [options.peerConnectionOptions] If this is set it will recreate the peer connection with the new options
         * @param {Array} [modifiers] Array with one time use description modifiers
         * @returns {Promise} Promise that resolves with the local description to be used for the session
         */
        getDescription: { writable: true, value: function (options, modifiers) {
                var _this = this;
                options = options || {};
                if (options.peerConnectionOptions) {
                    this.initPeerConnection(options.peerConnectionOptions);
                }
                // Merge passed constraints with saved constraints and save
                var newConstraints = Object.assign({}, this.constraints, options.constraints);
                newConstraints = this.checkAndDefaultConstraints(newConstraints);
                if (JSON.stringify(newConstraints) !== JSON.stringify(this.constraints)) {
                    this.constraints = newConstraints;
                    this.shouldAcquireMedia = true;
                }
                modifiers = modifiers || [];
                if (!Array.isArray(modifiers)) {
                    modifiers = [modifiers];
                }
                modifiers = modifiers.concat(this.modifiers);
                return Promise.resolve()
                    .then(function () {
                    if (_this.shouldAcquireMedia) {
                        return _this.acquire(_this.constraints).then(function () {
                            _this.shouldAcquireMedia = false;
                        });
                    }
                })
                    .then(function () { return _this.createOfferOrAnswer(options.RTCOfferOptions, modifiers); })
                    .then(function (description) {
                    _this.emit('getDescription', description);
                    return {
                        body: description.sdp,
                        contentType: _this.CONTENT_TYPE
                    };
                });
            } },
        /**
         * Check if the Session Description Handler can handle the Content-Type described by a SIP Message
         * @param {String} contentType The content type that is in the SIP Message
         * @returns {boolean}
         */
        hasDescription: { writable: true, value: function hasDescription(contentType) {
                return contentType === this.CONTENT_TYPE;
            } },
        /**
         * The modifier that should be used when the session would like to place the call on hold
         * @param {String} [sdp] The description that will be modified
         * @returns {Promise} Promise that resolves with modified SDP
         */
        holdModifier: { writable: true, value: function holdModifier(description) {
                if (!(/a=(sendrecv|sendonly|recvonly|inactive)/).test(description.sdp)) {
                    description.sdp = description.sdp.replace(/(m=[^\r]*\r\n)/g, '$1a=sendonly\r\n');
                }
                else {
                    description.sdp = description.sdp.replace(/a=sendrecv\r\n/g, 'a=sendonly\r\n');
                    description.sdp = description.sdp.replace(/a=recvonly\r\n/g, 'a=inactive\r\n');
                }
                return Promise.resolve(description);
            } },
        /**
         * Set the remote description to the underlying media implementation
         * @param {String} sessionDescription The description provided by a SIP message to be set on the media implementation
         * @param {Object} [options] Options object to be used by getDescription
         * @param {MediaStreamConstraints} [options.constraints] MediaStreamConstraints https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamConstraints
         * @param {Object} [options.peerConnectionOptions] If this is set it will recreate the peer connection with the new options
         * @param {Array} [modifiers] Array with one time use description modifiers
         * @returns {Promise} Promise that resolves once the description is set
         */
        setDescription: { writable: true, value: function setDescription(sessionDescription, options, modifiers) {
                var _this = this;
                options = options || {};
                if (options.peerConnectionOptions) {
                    this.initPeerConnection(options.peerConnectionOptions);
                }
                modifiers = modifiers || [];
                if (!Array.isArray(modifiers)) {
                    modifiers = [modifiers];
                }
                modifiers = modifiers.concat(this.modifiers);
                var description = {
                    type: this.hasOffer('local') ? 'answer' : 'offer',
                    sdp: sessionDescription
                };
                return Promise.resolve()
                    .then(function () {
                    // Media should be acquired in getDescription unless we need to do it sooner for some reason (FF61+)
                    if (_this.shouldAcquireMedia && _this.options.alwaysAcquireMediaFirst) {
                        return _this.acquire(_this.constraints).then(function () {
                            _this.shouldAcquireMedia = false;
                        });
                    }
                })
                    .then(function () { return SIP.Utils.reducePromises(modifiers, description); })
                    .catch(function (e) {
                    if (e instanceof SIP.Exceptions.SessionDescriptionHandlerError) {
                        throw e;
                    }
                    var error = new SIP.Exceptions.SessionDescriptionHandlerError("setDescription", e, "The modifiers did not resolve successfully");
                    _this.logger.error(error.message);
                    _this.emit('peerConnection-setRemoteDescriptionFailed', error);
                    throw error;
                })
                    .then(function (modifiedDescription) {
                    _this.emit('setDescription', modifiedDescription);
                    return _this.peerConnection.setRemoteDescription(modifiedDescription);
                })
                    .catch(function (e) {
                    if (e instanceof SIP.Exceptions.SessionDescriptionHandlerError) {
                        throw e;
                    }
                    // Check the original SDP for video, and ensure that we have want to do audio fallback
                    if ((/^m=video.+$/gm).test(sessionDescription) && !options.disableAudioFallback) {
                        // Do not try to audio fallback again
                        options.disableAudioFallback = true;
                        // Remove video first, then do the other modifiers
                        return _this.setDescription(sessionDescription, options, [SIP.Web.Modifiers.stripVideo].concat(modifiers));
                    }
                    var error = new SIP.Exceptions.SessionDescriptionHandlerError("setDescription", e);
                    _this.logger.error(error.error);
                    _this.emit('peerConnection-setRemoteDescriptionFailed', error);
                    throw error;
                })
                    .then(function () {
                    if (_this.peerConnection.getReceivers) {
                        _this.emit('setRemoteDescription', _this.peerConnection.getReceivers());
                    }
                    else {
                        _this.emit('setRemoteDescription', _this.peerConnection.getRemoteStreams());
                    }
                    _this.emit('confirmed', _this);
                });
            } },
        /**
         * Send DTMF via RTP (RFC 4733)
         * @param {String} tones A string containing DTMF digits
         * @param {Object} [options] Options object to be used by sendDtmf
         * @returns {boolean} true if DTMF send is successful, false otherwise
         */
        sendDtmf: { writable: true, value: function sendDtmf(tones, options) {
                if (!this.dtmfSender && this.hasBrowserGetSenderSupport()) {
                    var senders = this.peerConnection.getSenders();
                    if (senders.length > 0) {
                        this.dtmfSender = senders[0].dtmf;
                    }
                }
                if (!this.dtmfSender && this.hasBrowserTrackSupport()) {
                    var streams = this.peerConnection.getLocalStreams();
                    if (streams.length > 0) {
                        var audioTracks = streams[0].getAudioTracks();
                        if (audioTracks.length > 0) {
                            this.dtmfSender = this.peerConnection.createDTMFSender(audioTracks[0]);
                        }
                    }
                }
                if (!this.dtmfSender) {
                    return false;
                }
                try {
                    this.dtmfSender.insertDTMF(tones, options.duration, options.interToneGap);
                }
                catch (e) {
                    if (e.type === "InvalidStateError" || e.type === "InvalidCharacterError") {
                        this.logger.error(e);
                        return false;
                    }
                    else {
                        throw e;
                    }
                }
                this.logger.log('DTMF sent via RTP: ' + tones.toString());
                return true;
            } },
        getDirection: { writable: true, value: function getDirection() {
                return this.direction;
            } },
        // Internal functions
        createOfferOrAnswer: { writable: true, value: function createOfferOrAnswer(RTCOfferOptions, modifiers) {
                var _this = this;
                var methodName;
                var pc = this.peerConnection;
                RTCOfferOptions = RTCOfferOptions || {};
                methodName = this.hasOffer('remote') ? 'createAnswer' : 'createOffer';
                this.logger.log(methodName);
                return pc[methodName](RTCOfferOptions)
                    .catch(function (e) {
                    if (e instanceof SIP.Exceptions.SessionDescriptionHandlerError) {
                        throw e;
                    }
                    var error = new SIP.Exceptions.SessionDescriptionHandlerError("createOfferOrAnswer", e, 'peerConnection-' + methodName + 'Failed');
                    _this.emit('peerConnection-' + methodName + 'Failed', error);
                    throw error;
                })
                    .then(function (sdp) { return SIP.Utils.reducePromises(modifiers, _this.createRTCSessionDescriptionInit(sdp)); })
                    .then(function (sdp) {
                    _this.resetIceGatheringComplete();
                    _this.logger.log('Setting local sdp.');
                    _this.logger.log(sdp.sdp);
                    return pc.setLocalDescription(sdp);
                })
                    .catch(function (e) {
                    if (e instanceof SIP.Exceptions.SessionDescriptionHandlerError) {
                        throw e;
                    }
                    var error = new SIP.Exceptions.SessionDescriptionHandlerError("createOfferOrAnswer", e, 'peerConnection-SetLocalDescriptionFailed');
                    _this.emit('peerConnection-SetLocalDescriptionFailed', error);
                    throw error;
                })
                    .then(function () { return _this.waitForIceGatheringComplete(); })
                    .then(function () {
                    var localDescription = _this.createRTCSessionDescriptionInit(_this.peerConnection.localDescription);
                    return SIP.Utils.reducePromises(modifiers, localDescription);
                })
                    .then(function (localDescription) {
                    _this.setDirection(localDescription.sdp);
                    return localDescription;
                })
                    .catch(function (e) {
                    if (e instanceof SIP.Exceptions.SessionDescriptionHandlerError) {
                        throw e;
                    }
                    var error = new SIP.Exceptions.SessionDescriptionHandlerError("createOfferOrAnswer", e);
                    _this.logger.error(error);
                    throw error;
                });
            } },
        // Creates an RTCSessionDescriptionInit from an RTCSessionDescription
        createRTCSessionDescriptionInit: { writable: true, value: function createRTCSessionDescriptionInit(RTCSessionDescription) {
                return {
                    type: RTCSessionDescription.type,
                    sdp: RTCSessionDescription.sdp
                };
            } },
        addDefaultIceCheckingTimeout: { writable: true, value: function addDefaultIceCheckingTimeout(peerConnectionOptions) {
                if (peerConnectionOptions.iceCheckingTimeout === undefined) {
                    peerConnectionOptions.iceCheckingTimeout = 5000;
                }
                return peerConnectionOptions;
            } },
        addDefaultIceServers: { writable: true, value: function addDefaultIceServers(rtcConfiguration) {
                if (!rtcConfiguration.iceServers) {
                    rtcConfiguration.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
                }
                return rtcConfiguration;
            } },
        checkAndDefaultConstraints: { writable: true, value: function checkAndDefaultConstraints(constraints) {
                var defaultConstraints = { audio: true, video: !this.options.alwaysAcquireMediaFirst };
                constraints = constraints || defaultConstraints;
                // Empty object check
                if (Object.keys(constraints).length === 0 && constraints.constructor === Object) {
                    return defaultConstraints;
                }
                return constraints;
            } },
        hasBrowserTrackSupport: { writable: true, value: function hasBrowserTrackSupport() {
                return Boolean(this.peerConnection.addTrack);
            } },
        hasBrowserGetSenderSupport: { writable: true, value: function hasBrowserGetSenderSupport() {
                return Boolean(this.peerConnection.getSenders);
            } },
        initPeerConnection: { writable: true, value: function initPeerConnection(options) {
                var self = this;
                options = options || {};
                options = this.addDefaultIceCheckingTimeout(options);
                options.rtcConfiguration = options.rtcConfiguration || {};
                options.rtcConfiguration = this.addDefaultIceServers(options.rtcConfiguration);
                this.logger.log('initPeerConnection');
                if (this.peerConnection) {
                    this.logger.log('Already have a peer connection for this session. Tearing down.');
                    this.resetIceGatheringComplete();
                    this.peerConnection.close();
                }
                this.peerConnection = new this.WebRTC.RTCPeerConnection(options.rtcConfiguration);
                this.logger.log('New peer connection created');
                if ('ontrack' in this.peerConnection) {
                    this.peerConnection.addEventListener('track', function (e) {
                        self.logger.log('track added');
                        self.observer.trackAdded();
                        self.emit('addTrack', e);
                    });
                }
                else {
                    this.logger.warn('Using onaddstream which is deprecated');
                    this.peerConnection.onaddstream = function (e) {
                        self.logger.log('stream added');
                        self.emit('addStream', e);
                    };
                }
                this.peerConnection.onicecandidate = function (e) {
                    self.emit('iceCandidate', e);
                    if (e.candidate) {
                        self.logger.log('ICE candidate received: ' + (e.candidate.candidate === null ? null : e.candidate.candidate.trim()));
                    }
                    else if (e.candidate === null) {
                        // indicates the end of candidate gathering
                        self.logger.log('ICE candidate gathering complete');
                        self.triggerIceGatheringComplete();
                    }
                };
                this.peerConnection.onicegatheringstatechange = function () {
                    self.logger.log('RTCIceGatheringState changed: ' + this.iceGatheringState);
                    switch (this.iceGatheringState) {
                        case 'gathering':
                            self.emit('iceGathering', this);
                            if (!self.iceGatheringTimer && options.iceCheckingTimeout) {
                                self.iceGatheringTimeout = false;
                                self.iceGatheringTimer = setTimeout(function () {
                                    self.logger.log('RTCIceChecking Timeout Triggered after ' + options.iceCheckingTimeout + ' milliseconds');
                                    self.iceGatheringTimeout = true;
                                    self.triggerIceGatheringComplete();
                                }, options.iceCheckingTimeout);
                            }
                            break;
                        case 'complete':
                            self.triggerIceGatheringComplete();
                            break;
                    }
                };
                this.peerConnection.oniceconnectionstatechange = function () {
                    var stateEvent;
                    switch (this.iceConnectionState) {
                        case 'new':
                            stateEvent = 'iceConnection';
                            break;
                        case 'checking':
                            stateEvent = 'iceConnectionChecking';
                            break;
                        case 'connected':
                            stateEvent = 'iceConnectionConnected';
                            break;
                        case 'completed':
                            stateEvent = 'iceConnectionCompleted';
                            break;
                        case 'failed':
                            stateEvent = 'iceConnectionFailed';
                            break;
                        case 'disconnected':
                            stateEvent = 'iceConnectionDisconnected';
                            break;
                        case 'closed':
                            stateEvent = 'iceConnectionClosed';
                            break;
                        default:
                            self.logger.warn('Unknown iceConnection state:', this.iceConnectionState);
                            return;
                    }
                    self.logger.log('ICE Connection State changed to ' + stateEvent);
                    self.emit(stateEvent, this);
                };
            } },
        acquire: { writable: true, value: function acquire(constraints) {
                var _this = this;
                // Default audio & video to true
                constraints = this.checkAndDefaultConstraints(constraints);
                return new Promise(function (resolve, reject) {
                    /*
                     * Make the call asynchronous, so that ICCs have a chance
                     * to define callbacks to `userMediaRequest`
                     */
                    _this.logger.log('acquiring local media');
                    _this.emit('userMediaRequest', constraints);
                    if (constraints.audio || constraints.video) {
                        _this.WebRTC.getUserMedia(constraints)
                            .then(function (streams) {
                            _this.observer.trackAdded();
                            _this.emit('userMedia', streams);
                            resolve(streams);
                        }).catch(function (e) {
                            _this.emit('userMediaFailed', e);
                            reject(e);
                        });
                    }
                    else {
                        // Local streams were explicitly excluded.
                        resolve([]);
                    }
                })
                    .catch(function (e) {
                    if (e instanceof SIP.Exceptions.SessionDescriptionHandlerError) {
                        throw e;
                    }
                    var error = new SIP.Exceptions.SessionDescriptionHandlerError("acquire", e, "unable to acquire streams");
                    _this.logger.error(error.message);
                    _this.logger.error(error.error);
                    throw error;
                })
                    .then(function (streams) {
                    _this.logger.log('acquired local media streams');
                    try {
                        // Remove old tracks
                        if (_this.peerConnection.removeTrack) {
                            _this.peerConnection.getSenders().forEach(function (sender) {
                                _this.peerConnection.removeTrack(sender);
                            });
                        }
                        return streams;
                    }
                    catch (e) {
                        return Promise.reject(e);
                    }
                })
                    .catch(function (e) {
                    if (e instanceof SIP.Exceptions.SessionDescriptionHandlerError) {
                        throw e;
                    }
                    var error = new SIP.Exceptions.SessionDescriptionHandlerError("acquire", e, "error removing streams");
                    _this.logger.error(error.message);
                    _this.logger.error(error.error);
                    throw error;
                })
                    .then(function (streams) {
                    try {
                        streams = [].concat(streams);
                        streams.forEach(function (stream) {
                            if (_this.peerConnection.addTrack) {
                                stream.getTracks().forEach(function (track) {
                                    _this.peerConnection.addTrack(track, stream);
                                });
                            }
                            else {
                                // Chrome 59 does not support addTrack
                                _this.peerConnection.addStream(stream);
                            }
                        });
                    }
                    catch (e) {
                        return Promise.reject(e);
                    }
                    return Promise.resolve();
                })
                    .catch(function (e) {
                    if (e instanceof SIP.Exceptions.SessionDescriptionHandlerError) {
                        throw e;
                    }
                    var error = new SIP.Exceptions.SessionDescriptionHandlerError("acquire", e, "error adding stream");
                    _this.logger.error(error.message);
                    _this.logger.error(error.error);
                    throw error;
                });
            } },
        hasOffer: { writable: true, value: function hasOffer(where) {
                var offerState = 'have-' + where + '-offer';
                return this.peerConnection.signalingState === offerState;
            } },
        // ICE gathering state handling
        isIceGatheringComplete: { writable: true, value: function isIceGatheringComplete() {
                return this.peerConnection.iceGatheringState === 'complete' || this.iceGatheringTimeout;
            } },
        resetIceGatheringComplete: { writable: true, value: function resetIceGatheringComplete() {
                this.iceGatheringTimeout = false;
                this.logger.log('resetIceGatheringComplete');
                if (this.iceGatheringTimer) {
                    clearTimeout(this.iceGatheringTimer);
                    this.iceGatheringTimer = null;
                }
                if (this.iceGatheringDeferred) {
                    this.iceGatheringDeferred.reject();
                    this.iceGatheringDeferred = null;
                }
            } },
        setDirection: { writable: true, value: function setDirection(sdp) {
                var match = sdp.match(/a=(sendrecv|sendonly|recvonly|inactive)/);
                if (match === null) {
                    this.direction = this.C.DIRECTION.NULL;
                    this.observer.directionChanged();
                    return;
                }
                var direction = match[1];
                switch (direction) {
                    case this.C.DIRECTION.SENDRECV:
                    case this.C.DIRECTION.SENDONLY:
                    case this.C.DIRECTION.RECVONLY:
                    case this.C.DIRECTION.INACTIVE:
                        this.direction = direction;
                        break;
                    default:
                        this.direction = this.C.DIRECTION.NULL;
                        break;
                }
                this.observer.directionChanged();
            } },
        triggerIceGatheringComplete: { writable: true, value: function triggerIceGatheringComplete() {
                if (this.isIceGatheringComplete()) {
                    this.emit('iceGatheringComplete', this);
                    if (this.iceGatheringTimer) {
                        clearTimeout(this.iceGatheringTimer);
                        this.iceGatheringTimer = null;
                    }
                    if (this.iceGatheringDeferred) {
                        this.iceGatheringDeferred.resolve();
                        this.iceGatheringDeferred = null;
                    }
                }
            } },
        waitForIceGatheringComplete: { writable: true, value: function waitForIceGatheringComplete() {
                this.logger.log('waitForIceGatheringComplete');
                if (this.isIceGatheringComplete()) {
                    this.logger.log('ICE is already complete. Return resolved.');
                    return Promise.resolve();
                }
                else if (!this.isIceGatheringDeferred) {
                    this.iceGatheringDeferred = SIP.Utils.defer();
                }
                this.logger.log('ICE is not complete. Returning promise');
                return this.iceGatheringDeferred.promise;
            } }
    });
    return SessionDescriptionHandler;
};