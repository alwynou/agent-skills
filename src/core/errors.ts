export class UserError extends Error {
  override name = "UserError";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
