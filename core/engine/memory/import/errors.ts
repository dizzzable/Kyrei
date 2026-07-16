export type ImportErrorCode =
  | "import_adapter_parse_failed"
  | "import_transcript_empty"
  | "import_format_unsupported"
  | "import_format_ambiguous"
  | "import_payload_too_large"
  | "import_duplicate"
  | "import_workspace_invalid"
  | "import_invalid_input";

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly details?: unknown;

  constructor(code: ImportErrorCode, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = "ImportError";
    this.code = code;
    this.details = details;
  }
}
