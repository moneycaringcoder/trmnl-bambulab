/**
 * Setup failures.
 *
 * Every failure carries an instruction. "HTTP 401" on its own is a bug in this
 * program; "Your Bambu Cloud token expired. Run `pnpm setup reauth`." is the
 * contract.
 */

export class SetupError extends Error {
  // Plain fields, not parameter properties: the CLI runs from source under
  // Node's type stripping, which cannot rewrite a parameter property.
  guidance: string;
  /** True when the user asked to stop; the CLI exits quietly. */
  cancelled: boolean;

  constructor(message: string, guidance: string, cancelled = false) {
    super(message);
    this.name = "SetupError";
    this.guidance = guidance;
    this.cancelled = cancelled;
  }
}

export const CANCELLED = new SetupError(
  "Setup cancelled. Nothing was written.",
  "Run `pnpm setup` again whenever you are ready.",
  true,
);
