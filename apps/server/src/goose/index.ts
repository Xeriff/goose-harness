// Goose Harness's entry into the server: server.ts mounts these; McpHttpServer.ts adds GooseMcpTools.
export { layer as hostLayer } from "./GooseExtensionHost.ts";
export { layer as httpLayer } from "./GooseHttp.ts";
