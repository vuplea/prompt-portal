// A client-caused error — bad input or an unmet precondition — whose message
// is safe to return verbatim in a 4xx. Anything thrown that is NOT a
// ClientError is an unexpected server fault: the API surfaces it as a generic
// 500 without leaking the underlying message (which can carry filesystem paths
// and the like).
export class ClientError extends Error {}

// A CLI error meant for the user, printed without a stack trace — thrown by
// the prompt-portal commands and the hub's own CLI (set-password, flag parsing).
export class CliError extends Error {}
