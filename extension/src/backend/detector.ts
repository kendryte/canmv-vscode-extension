import { Methods, createRequest } from '../protocol/methods';
import { Request, Response, ProtocolError, isResponse } from '../protocol/types';
import { logError } from '../output';

export interface DetectedBoard {
  port: string;
  name: string;
  vid: string;
  pid: string;
  serialNumber?: string;
  description?: string;
}

export interface BoardDetectorApi {
  scan(): Promise<DetectedBoard[]>;
}

interface ProtocolRequester {
  request(req: Request<string>): Promise<Response | ProtocolError>;
}

export class BoardDetector implements BoardDetectorApi {
  constructor(private requester: ProtocolRequester) {}

  async scan(): Promise<DetectedBoard[]> {
    const result = await this.requester.request(createRequest(Methods.detectBoards, {}));
    if (isResponse(result)) {
      const payload = result.result as { boards?: DetectedBoard[] };
      return Array.isArray(payload.boards) ? payload.boards : [];
    }

    logError('Board', `Detect failed: ${result.error.message}`);
    return [];
  }
}
