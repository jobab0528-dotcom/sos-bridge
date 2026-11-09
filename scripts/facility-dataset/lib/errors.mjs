// Error type shared by the generator modules. `code` is stable and machine
// readable; `details` holds JSON-safe structured data for the CLI output.

export class DatasetBuildError extends Error{
  constructor(code, message, details = {}){
    super(`${code}: ${message}`);
    this.name = "DatasetBuildError";
    this.code = code;
    this.details = details;
  }
}
