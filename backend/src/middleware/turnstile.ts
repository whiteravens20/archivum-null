import { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';

interface TurnstileResponse {
  success: boolean;
  'error-codes'?: string[];
  hostname?: string;
}

export async function verifyTurnstile(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!config.TURNSTILE_ENABLED) return;

  const token =
    (request.headers['x-turnstile-token'] as string) ||
    ((request.body as Record<string, unknown>)?.turnstileToken as string);

  if (!token) {
    reply.status(403).send({ error: 'Missing captcha token' });
    return;
  }

  try {
    const formData = new URLSearchParams();
    formData.append('secret', config.TURNSTILE_SECRET);
    formData.append('response', token);
    formData.append('remoteip', request.ip);

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });

    const data = (await res.json()) as TurnstileResponse;

    if (!data.success) {
      request.log.warn({ errors: data['error-codes'] }, 'Turnstile verification failed');
      reply.status(403).send({ error: 'Captcha verification failed' });
      return;
    }
  } catch (err) {
    request.log.error(err, 'Turnstile API call failed');
    reply.status(500).send({ error: 'Captcha service unavailable' });
  }
}
