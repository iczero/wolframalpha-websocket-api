// @ts-check
const WebSocket = require('ws');
const EventEmitter = require('events');
const uuid = require('uuid/v4');
const debug = require('debug')('wolframalpha:api');

const API_URL = 'wss://www.wolframalpha.com/n/v1/api/fetcher/results';
const API_ORIGIN = 'https://www.wolframalpha.com';
const USER_AGENT_DEFAULT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.97 Safari/537.36';

/** A simple Deferred implenetation */
class Deferred {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** Represents a response from the API */
class Response extends EventEmitter {
  /**
   * The constructor
   * @param {WolframAlphaApi} api API instance of the response
   * @param {string} id Query id (also known as locationId)
   */
  constructor(api, id) {
    super();
    this.api = api;
    this.id = id;
    /** @type {any[]} */
    this.responseObjects = [];

    this.deferred = new Deferred();
    this.promise = this.deferred.promise;

    // i don't actually know if these are used
    /** @type {string} */
    this.server = null;
    /** @type {string} */
    this.host = null;
  }

  /**
   * Called after receiving a response object
   * @param {any} obj
   */
  handleResponseObject(obj) {
    this.responseObjects.push(obj);
    this.emit('responseObject', obj);
  }
}

/** Represents a query result */
class QueryResult extends Response {
  /**
   * The constructor
   * @param {WolframAlphaApi} api
   * @param {string} id
   * @param {string} input
   * @param {string[]} assumptions
   */
  constructor(api, id, input, assumptions) {
    super(api, id);
    this.originalInput = input;
    this.inputAssumptions = assumptions;
    /**
     * Corrected input, may be the same as the original input
     * @type {string}
     */
    this.correctedInput = null;
    /**
     * "did you mean" suggestions
     * @type {object[]}
     */
    this.didYouMean = [];
    /**
     * Received pods by position
     * @type {Map<number, object>}
     */
    this.pods = new Map();
    /**
     * Pods returned as errors
     * @type {object[]}
     */
    this.erroredPods = [];
    /**
     * Received step-by-step pods by position
     * NOTE: will not be complete as a pro subscription is required
     * @type {Map<number, object>}
     */
    this.stepByStep = new Map();
    /**
     * Received assumptions
     * @type {object[]}
     */
    this.assumptions = [];
    /**
     * Received warnings
     * @type {object[]}
     */
    this.warnings = [];
    /** Set to true if noResult was returned */
    this.failed = false;
    /**
     * Received "future topics" list
     * @type {any[]}
     */
    this.futureTopic = [];
    /**
     * List of timed out queries
     * @type {string[]}
     */
    this.timedOut = [];
  }
  /**
   * Called after receiving a response object
   * @param {any} obj
   */
  handleResponseObject(obj) {
    super.handleResponseObject(obj);
    if (obj.input) this.correctedInput = obj.input;
    if (obj.s) this.server = obj.s;
    if (obj.host) this.host = obj.host;
    switch (obj.type) {
      case 'queryComplete': {
        this.timedOut = obj.timedOut;
        this.deferred.resolve();
        this.api.pendingResponses.delete(this.id);
        break;
      }
      case 'didyoumean': {
        this.didYouMean.push(...obj.didyoumean);
        this.api.pendingResponses.delete(this.id);
        this.id += '_dym';
        this.api.pendingResponses.set(this.id, this);
        break;
      }
      case 'assumptions': {
        for (let assumption of obj.assumptions) {
          let template = assumption.template;
          let assumptions = assumption.values;
          let str = '';
          let chunks = template.split(/\${\w*}/);
          let keys = template.match(/(\${\w*})/g);
          let descIndex = 0;
          if (assumptions[0] && template.includes(assumptions[0].desc)) descIndex = 1;
          let o = assumption;
          for (let i = 0; i < keys.length; i++) {
            str += chunks[i];
            switch (keys[i]) {
              case '${desc}': {
                let val = assumptions[descIndex++];
                if (val) str += val.desc;
                break;
              }
              case '${separator}': {
                str += ' | ';
                break;
              }
              case '${word}': {
                // i stole this from wolframalpha bundle.js don't judge
                str += 'AssumingWord' === o.word
                  ? o.values[0].desc
                  : o.word
                    ? o.word
                    : o.values[0].word
                      ? ' the input ' === o.values[0].word
                        ? o.query
                        : o.values[0].word
                      : o.query;
                break;
              }
              default: {
                str += keys[i];
              }
            }
          }
          str += chunks[keys.length];
          assumption.string = str;
          this.assumptions.push(assumption);
        }
        break;
      }
      case 'pods': {
        for (let pod of obj.pods) {
          if (pod.error) this.erroredPods.push(pod);
          else this.pods.set(pod.position, pod);
        }
        break;
      }
      case 'stepByStep': {
        this.stepByStep.set(obj.pod.position, obj.pod);
        break;
      }
      case 'warnings': {
        if (Array.isArray(obj.warnings)) this.warnings.push(...obj.warnings);
        else this.warnings.push(obj.warnings);
        break;
      }
      case 'noResult': {
        this.failed = true;
        break;
      }
      case 'futureTopic': {
        this.futureTopic.push(obj.futureTopic);
        break;
      }
    }
  }
}

/** Represents a consumer of the wolframalpha websocket api */
class WolframAlphaApi {
  /**
   * The constructor
   * @param {object} [opts]
   * @param {string} [opts.apiUrl] URL of the websocket endpoint
   * @param {string} [opts.origin] Origin of the api server
   * @param {string} [opts.userAgent] User agent to use
   * @param {object} [opts.headers] Additional headers
   * @param {string} [opts.language=en] Language code
   */
  constructor(opts) {
    opts = Object.assign({
      userAgent: USER_AGENT_DEFAULT,
      origin: API_ORIGIN,
      apiUrl: API_URL,
      language: 'en',
      headers: {}
    }, opts);
    this.headers = {
      'User-Agent': opts.userAgent,
      'Origin': opts.origin,
      ...opts.headers
    };
    this.url = opts.apiUrl;
    this.language = opts.language;

    /** @type {Map<string, Response>} */
    this.pendingResponses = new Map();
    /** @type {WebSocket} */
    this.socket = null;
    /** @type {any[]} */
    this._queue = [];
    this.socketReady = false;
  }

  /** Connect websocket */
  doWebsocketConnect() {
    let socket = this.socket = new WebSocket(this.url, {
      headers: this.headers
    });
    socket.on('open', () => {
      debug('websocket open, sending %d queued messages', this._queue.length);
      this.socket.send(JSON.stringify({
        type: 'init',
        lang: this.language,
        exp: Date.now(),
        messages: this._queue
      }));
      this._queue = [];
      this.socketReady = true;
    });
    socket.on('error', error => {
      debug('websocket error: %O', error);
      this.socketReady = false;
      this.socket = null;
      for (let response of this.pendingResponses.values()) {
        response.deferred.reject(error);
      }
    });
    socket.on('close', (code, reason) => {
      this.socket = null;
      this.socketReady = false;
      debug('socket close %d (%s)', code, reason);
    });
    socket.on('message', this.handleMessage.bind(this));
    socket.on('ping', data => debug('ping received %o', data));
    socket.on('pong', data => debug('pong received %o', data));
  }

  /**
   * Send a message over the websocket, creating a new socket if necessary
   * @param {any} message
   */
  sendMessage(message) {
    debug('send message %o', message);
    if (this.socketReady) this.socket.send(JSON.stringify(message));
    else {
      this._queue.push(message);
      if (!this.socket) this.doWebsocketConnect();
    }
  }

  /**
   * Handle a message from websocket
   * @param {any} response
   */
  handleMessage(response) {
    response = JSON.parse(response);
    debug('received message %o', response);
    let res = this.pendingResponses.get(response.locationId);
    if (!res) {
      debug('no response object found for id %s', response.locationId);
      return;
    }
    res.handleResponseObject(response);
  }

  /**
   * Query wolframalpha
   * @param {string} input Search input
   * @param {string[]} assumptions Input assupmtions (?)
   * @return {QueryResult}
   */
  query(input, assumptions = []) {
    let id = uuid();
    let response = new QueryResult(this, id, input, assumptions);
    let request = {
      type: 'newQuery',
      language: this.language,
      file: null,
      input,
      assumption: assumptions,
      locationId: id
    };
    this.pendingResponses.set(id, response);
    this.sendMessage(request);
    return response;
  }
}

exports.WolframAlphaApi = WolframAlphaApi;
exports.Response = Response;
exports.QueryResult = QueryResult;
exports.Deferred = Deferred;
