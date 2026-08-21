import type { WireError } from "../types.ts";

/** A wire-format failure carrying its structured payload through the stack. */
export class WireErrorException extends Error {
	readonly wireError: WireError;

	constructor(wireError: WireError) {
		super(wireError.message);
		this.name = "WireErrorException";
		this.wireError = wireError;
	}
}

export function invalidRequest(message: string): WireErrorException {
	return new WireErrorException({ status: 400, code: "invalid_request", message });
}

export function modelNotFound(model: string): WireErrorException {
	return new WireErrorException({
		status: 404,
		code: "model_not_found",
		message: `Unknown model: ${model}`,
	});
}

export function unauthorized(message = "Missing or invalid API key"): WireErrorException {
	return new WireErrorException({ status: 401, code: "unauthorized", message });
}

/** Render a WireError in the OpenAI error envelope shape. */
export function renderErrorEnvelope(err: WireError): {
	error: { message: string; type: string; code: string };
} {
	return {
		error: {
			message: err.message,
			type:
				err.status === 401
					? "authentication_error"
					: err.status === 429
						? "rate_limit_error"
						: err.status >= 500
							? "server_error"
							: "invalid_request_error",
			code: err.code,
		},
	};
}
