interface BrowserlessRecording {
  events: any[];
  sessionId: string;
  _buf?: any[];
  _ft?: ReturnType<typeof setTimeout> | null;
  _rrwebError?: string;
}

interface BrowserlessXHRInfo {
  method: string;
  url: string;
  id: string;
  requestHeaders: Record<string, string>;
}

declare global {
  interface Window {
    __browserlessRecording: BrowserlessRecording | true | undefined;
    __browserlessStopRecording?: () => void;
    __browserlessNetworkSetup?: boolean;
    __rrwebPush?: (json: string) => void;
    rrweb: {
      record: (options: any) => () => void;
    };
    rrwebConsolePlugin?: {
      getRecordConsolePlugin: (options: any) => any;
    };
  }

  interface XMLHttpRequest {
    __browserlessXHR?: BrowserlessXHRInfo;
  }
}

export {};
