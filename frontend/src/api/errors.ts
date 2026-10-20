/**
 * A request to the server that did not succeed. The pages say what went wrong from the
 * status, in the visitor's language. The message keeps what the server said, in
 * English; it is not shown.
 */
export class ApiError extends Error {
  /** The HTTP status of the answer, or null when no answer came. */
  readonly status: number | null;

  constructor(status: number | null, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
