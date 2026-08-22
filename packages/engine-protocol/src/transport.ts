export interface ProxyTransport {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
