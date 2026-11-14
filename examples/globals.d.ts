// The repo compiles with "types": [] (no node typings on purpose — the
// library must not depend on them). Examples do print a lot, so declare
// just the console slice they use. Copying an example into your own
// project? Bring your own types; this file is build plumbing, not an API.
declare const console: {
    log(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
};
