/** An error with an HTTP status and a stable machine-readable code, rendered as `{ error, message }`. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string) => new HttpError(400, code, message);
export const unauthorized = (message: string) => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "not allowed for this key") => new HttpError(403, "forbidden", message);
export const notFound = (what = "resource") => new HttpError(404, "not_found", `${what} not found`);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
