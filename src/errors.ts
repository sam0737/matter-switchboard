export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = "request_failed",
  ) {
    super(message);
    this.name = "HttpError";
  }
}
