import { Injectable, ServiceUnavailableException } from '@nestjs/common';

@Injectable()
export class AiConfig {
  private readonly apiUrl = process.env.AI_API_URL?.trim();
  private readonly apiKey = process.env.AI_API_KEY?.trim();
  private readonly model = process.env.AI_MODEL?.trim();

  status() {
    return {
      configured: !!(this.apiUrl && this.apiKey && this.model),
      model: this.model ?? null,
    };
  }

  provider() {
    if (!this.apiUrl || !this.apiKey || !this.model) {
      throw new ServiceUnavailableException(
        'AI is not configured. Ask your administrator to enable it.',
      );
    }
    let url: URL;
    try {
      url = new URL(this.apiUrl);
    } catch {
      throw new ServiceUnavailableException('The AI provider URL is invalid.');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new ServiceUnavailableException(
        'The AI provider must use an HTTPS base URL without credentials or query parameters.',
      );
    }
    return {
      url: `${url.href.replace(/\/$/, '')}/chat/completions`,
      apiKey: this.apiKey,
      model: this.model,
    };
  }
}
