/** An error with an HTTP status, a stable code for the frontend and a short lowercase message for people. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, code = 'bad_request') => new ApiError(400, code, message);
export const notFound = (message = "that torrent isn't in your list") => new ApiError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict') => new ApiError(409, code, message);
export const unauthorized = (message = 'start a session first') => new ApiError(401, 'no_session', message);
export const forbidden = (message: string, code = 'forbidden') => new ApiError(403, code, message);
export const tooLarge = (message: string, code = 'too_large') => new ApiError(413, code, message);
