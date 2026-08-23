export interface ProxyTransport {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}
