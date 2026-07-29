"""AWS Lambda handler for calling Claude via API Gateway.

GET /?prompt=...&max_tokens=...  ->  { prompt, response, model, stop_reason, usage }

Deploy with the anthropic package from lambda/requirements.txt bundled into the
function (or a Lambda layer), and ANTHROPIC_API_KEY set as an environment variable
on the function.
"""

import json
import os

import anthropic

MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5")
DEFAULT_MAX_TOKENS = 500

# Reused across warm invocations of the same Lambda execution environment.
_client = None


def _get_client():
    global _client
    if _client is None:
        _client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment
    return _client


def _response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps(body),
    }


def lambda_handler(event, context):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return _response(500, {"error": "ANTHROPIC_API_KEY is not configured on this Lambda function."})

    params = event.get("queryStringParameters") or {}
    prompt = params.get("prompt", "Hello Claude!")

    try:
        max_tokens = int(params.get("max_tokens", DEFAULT_MAX_TOKENS))
    except (TypeError, ValueError):
        return _response(400, {"error": "max_tokens must be an integer."})

    try:
        message = _get_client().messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
    except anthropic.AuthenticationError:
        return _response(401, {"error": "Invalid or missing ANTHROPIC_API_KEY."})
    except anthropic.RateLimitError:
        return _response(429, {"error": "Rate limited by the Claude API. Retry shortly."})
    except anthropic.APIStatusError as err:
        return _response(err.status_code, {"error": err.message})
    except anthropic.APIConnectionError:
        return _response(502, {"error": "Could not reach the Claude API."})

    if message.stop_reason == "refusal":
        return _response(200, {"error": "Claude declined to respond to this prompt."})

    text = next((block.text for block in message.content if block.type == "text"), "")

    return _response(200, {
        "prompt": prompt,
        "response": text,
        "model": message.model,
        "stop_reason": message.stop_reason,
        "usage": {
            "input_tokens": message.usage.input_tokens,
            "output_tokens": message.usage.output_tokens,
        },
    })
