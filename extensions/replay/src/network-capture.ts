/// <reference path="./globals.d.ts" />

if (window.__browserlessNetworkSetup) {
  // Already initialized — bail out
} else {
  window.__browserlessNetworkSetup = true;

  const recording = window.__browserlessRecording;
  if (recording && recording !== true) {
    const MAX_BODY_SIZE = 10240;

    function emitNetworkEvent(tag: string, payload: Record<string, any>): void {
      const event = {
        type: 5,
        timestamp: Date.now(),
        data: { tag, payload },
      };
      if (window.__rrwebPush) {
        try {
          window.__rrwebPush(JSON.stringify([event]));
        } catch (e) {
          recording.events.push(event);
        }
      } else {
        recording.events.push(event);
      }
    }

    function truncateBody(body: any, maxSize: number): string | null {
      if (!body) return null;
      if (typeof body !== 'string') {
        try {
          body = JSON.stringify(body);
        } catch (e) {
          body = String(body);
        }
      }
      if (body.length > maxSize) {
        return body.substring(0, maxSize) + '... [truncated]';
      }
      return body;
    }

    function headersToObject(headers: any): Record<string, string> | null {
      if (!headers) return null;
      const obj: Record<string, string> = {};
      try {
        if (headers instanceof Headers) {
          headers.forEach((value: string, key: string) => {
            obj[key] = value;
          });
        } else if (typeof headers === 'object') {
          if (Array.isArray(headers)) {
            headers.forEach((pair: any) => {
              if (Array.isArray(pair) && pair.length >= 2) obj[pair[0]] = pair[1];
            });
          } else {
            Object.keys(headers).forEach((key) => {
              obj[key] = headers[key];
            });
          }
        }
      } catch (e) {
        return null;
      }
      return Object.keys(obj).length > 0 ? obj : null;
    }

    function isBinaryContentType(contentType: string): boolean {
      if (!contentType) return false;
      const binaryTypes = ['image/', 'audio/', 'video/', 'application/octet-stream', 'application/pdf', 'application/zip'];
      return binaryTypes.some((type) => contentType.toLowerCase().indexOf(type) !== -1);
    }

    function parseXHRHeaders(headerStr: string): Record<string, string> | null {
      if (!headerStr) return null;
      const headers: Record<string, string> = {};
      const pairs = headerStr.trim().split('\r\n');
      pairs.forEach((pair) => {
        const idx = pair.indexOf(':');
        if (idx > 0) {
          const key = pair.substring(0, idx).trim().toLowerCase();
          const value = pair.substring(idx + 1).trim();
          headers[key] = value;
        }
      });
      return Object.keys(headers).length > 0 ? headers : null;
    }

    // -- Intercept fetch ---------------------------------------------------
    const originalFetch = window.fetch;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const startTime = Date.now();
      const url = typeof input === 'string' ? input : (input as any).url || String(input);
      const method = (init && init.method) || 'GET';
      const requestId = Math.random().toString(36).substr(2, 9);

      let requestHeaders: Record<string, string> | null = null;
      try {
        if (init && init.headers) {
          requestHeaders = headersToObject(init.headers);
        } else if (input instanceof Request) {
          requestHeaders = headersToObject(input.headers);
        }
      } catch (e) {}

      let requestBody: string | null = null;
      try {
        if (init && init.body) {
          if (typeof init.body === 'string') {
            requestBody = truncateBody(init.body, MAX_BODY_SIZE);
          } else if (init.body instanceof FormData) {
            requestBody = '[FormData]';
          } else if (init.body instanceof Blob) {
            requestBody = '[Blob: ' + init.body.size + ' bytes]';
          } else if (init.body instanceof ArrayBuffer) {
            requestBody = '[ArrayBuffer: ' + init.body.byteLength + ' bytes]';
          } else {
            requestBody = truncateBody(init.body, MAX_BODY_SIZE);
          }
        }
      } catch (e) {}

      emitNetworkEvent('network.request', {
        id: requestId, url, method, type: 'fetch',
        timestamp: startTime, headers: requestHeaders, body: requestBody,
      });

      return originalFetch.apply(this, arguments as any).then((response: Response) => {
        let responseHeaders: Record<string, string> | null = null;
        try { responseHeaders = headersToObject(response.headers); } catch (e) {}
        let contentType = '';
        try { contentType = response.headers.get('content-type') || ''; } catch (e) {}

        let responseBodyPromise: Promise<string | null> = Promise.resolve(null);
        if (!isBinaryContentType(contentType)) {
          try {
            responseBodyPromise = response.clone().text().then((text) => {
              return truncateBody(text, MAX_BODY_SIZE);
            }).catch(() => null);
          } catch (e) {}
        }

        responseBodyPromise.then((responseBody) => {
          emitNetworkEvent('network.response', {
            id: requestId, url, method, status: response.status,
            statusText: response.statusText, duration: Date.now() - startTime,
            type: 'fetch', headers: responseHeaders, body: responseBody,
            contentType: contentType || null,
          });
        });

        return response;
      }).catch((error: Error) => {
        emitNetworkEvent('network.error', {
          id: requestId, url, method,
          error: error.message || String(error),
          duration: Date.now() - startTime, type: 'fetch',
        });
        throw error;
      });
    };

    // -- Intercept XMLHttpRequest ------------------------------------------
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method: string, url: string | URL) {
      this.__browserlessXHR = {
        method,
        url: String(url),
        id: Math.random().toString(36).substr(2, 9),
        requestHeaders: {},
      };
      return originalXHROpen.apply(this, arguments as any);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
      if (this.__browserlessXHR) {
        this.__browserlessXHR.requestHeaders[name.toLowerCase()] = value;
      }
      return originalXHRSetRequestHeader.apply(this, arguments as any);
    };

    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      const xhr = this;
      const info = xhr.__browserlessXHR;
      if (!info) return originalXHRSend.apply(this, arguments as any);

      const startTime = Date.now();
      let requestBody: string | null = null;
      try {
        if (body) {
          if (typeof body === 'string') {
            requestBody = truncateBody(body, MAX_BODY_SIZE);
          } else if (body instanceof FormData) {
            requestBody = '[FormData]';
          } else if (body instanceof Blob) {
            requestBody = '[Blob: ' + body.size + ' bytes]';
          } else if (body instanceof ArrayBuffer) {
            requestBody = '[ArrayBuffer: ' + body.byteLength + ' bytes]';
          } else if (body instanceof Document) {
            requestBody = '[Document]';
          } else {
            requestBody = truncateBody(body, MAX_BODY_SIZE);
          }
        }
      } catch (e) {}

      emitNetworkEvent('network.request', {
        id: info.id, url: info.url, method: info.method, type: 'xhr',
        timestamp: startTime,
        headers: Object.keys(info.requestHeaders).length > 0 ? info.requestHeaders : null,
        body: requestBody,
      });

      xhr.addEventListener('load', () => {
        let responseHeaders: Record<string, string> | null = null;
        try { responseHeaders = parseXHRHeaders(xhr.getAllResponseHeaders()); } catch (e) {}
        let contentType = '';
        try { contentType = xhr.getResponseHeader('content-type') || ''; } catch (e) {}

        let responseBody: string | null = null;
        if (!isBinaryContentType(contentType)) {
          try {
            if (xhr.responseType === '' || xhr.responseType === 'text') {
              responseBody = truncateBody(xhr.responseText, MAX_BODY_SIZE);
            } else if (xhr.responseType === 'json') {
              responseBody = truncateBody(JSON.stringify(xhr.response), MAX_BODY_SIZE);
            } else if (xhr.responseType === 'document' && xhr.responseXML) {
              responseBody = '[XML Document]';
            } else {
              responseBody = '[' + xhr.responseType + ' response]';
            }
          } catch (e) {}
        }

        emitNetworkEvent('network.response', {
          id: info.id, url: info.url, method: info.method,
          status: xhr.status, statusText: xhr.statusText,
          duration: Date.now() - startTime, type: 'xhr',
          headers: responseHeaders, body: responseBody,
          contentType: contentType || null,
        });
      });

      xhr.addEventListener('error', () => {
        emitNetworkEvent('network.error', {
          id: info.id, url: info.url, method: info.method,
          error: 'Network error', duration: Date.now() - startTime, type: 'xhr',
        });
      });

      xhr.addEventListener('abort', () => {
        emitNetworkEvent('network.error', {
          id: info.id, url: info.url, method: info.method,
          error: 'Request aborted', duration: Date.now() - startTime, type: 'xhr',
        });
      });

      return originalXHRSend.apply(this, arguments as any);
    };

    console.log('[browserless-ext] Network capture enabled');
  }
}
