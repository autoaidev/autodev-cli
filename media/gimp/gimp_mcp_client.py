#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# gimp_mcp_client.py — vendored, USER-VERIFIED GIMP MCP client (FastMCP stdio).
#
# Derived from libreearth/gimp-mcp (GPL-3.0; see media/gimp/LICENSE) and fixed by
# the user / AutoDev: reconnect via getpeername, reads > 1024 bytes, get_images.
# Launched by: uv run --with mcp==1.2.0 <this file>. The body below is kept
# byte-for-byte; the lines in THIS block are a provenance comment only.
# ---------------------------------------------------------------------------

# GIMP MCP Server Script
# Provides an MCP interface to control GIMP via a socket connection.

from mcp.server.fastmcp import FastMCP, Context
import socket
import json
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("GimpMCPServer")


class GimpConnection:
    def __init__(self, host='127.0.0.1', port=9877):
        self.host = host
        self.port = port
        self.sock = None

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
        self.sock = None

    def connect(self):
        if self.sock:
            try:
                self.sock.getpeername()
                return
            except Exception:
                self.close()
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(30)
            sock.connect((self.host, self.port))
            self.sock = sock
            logger.info(f"Connected to GIMP at {self.host}:{self.port}")
        except Exception as e:
            self.close()
            logger.error(f"Failed to connect: {e}")
            raise ConnectionError(
                "Could not connect to GIMP. Open GIMP and run "
                "Filters > Development > Start MCP Server."
            )

    def send_command(self, command_type, params=None):
        self.connect()
        command = {"type": command_type, "params": params or {}}
        try:
            self.sock.sendall(json.dumps(command).encode('utf-8'))
            chunks = []
            while True:
                data = self.sock.recv(65536)
                if not data:
                    break
                chunks.append(data)
                try:
                    return json.loads(b''.join(chunks).decode('utf-8'))
                except json.JSONDecodeError:
                    continue
            raise Exception("GIMP closed the connection before sending a complete response")
        except Exception as e:
            logger.error(f"Communication error: {e}")
            self.close()
            raise Exception(f"Error communicating with GIMP: {e}")


_gimp_connection = None


def get_gimp_connection():
    global _gimp_connection
    if _gimp_connection is None:
        _gimp_connection = GimpConnection()
    _gimp_connection.connect()
    return _gimp_connection


mcp = FastMCP("GimpMCP", description="GIMP integration through MCP")


@mcp.tool()
def call_api(ctx: Context, api_path: str, args: list = [], kwargs: dict = {}) -> str:
    """Call any GIMP API method dynamically.

    Parameters:
    - api_path: The path to the API method (e.g., "Gimp.Image.get_by_id")
      Use "exec" to run Python inside GIMP. Pass the code in args[0].
    - args: List of positional arguments
    - kwargs: Dictionary of keyword arguments

    Returns:
    - JSON string of the result or error message
    """
    try:
        conn = get_gimp_connection()
        result = conn.send_command("call_api", {"api_path": api_path, "args": args, "kwargs": kwargs})
        if result["status"] == "success":
            return json.dumps(result["result"])
        return f"Error: {result['message']}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def list_images(ctx: Context) -> str:
    """List all open images in GIMP.

    Returns:
    - JSON string of image IDs and names
    """
    return call_api(ctx, "Gimp.get_images")


@mcp.tool()
def get_image_info(ctx: Context, image_id: int) -> str:
    """Get information about a specific image.

    Parameters:
    - image_id: The ID of the image

    Returns:
    - JSON string of image details
    """
    return call_api(
        ctx,
        "exec",
        args=[
            f"""
image = Gimp.Image.get_by_id({int(image_id)})
if image is None:
    _result = {{"error": "image not found"}}
else:
    _result = {{
        "id": image.get_id(),
        "name": image.get_name(),
        "width": image.get_width(),
        "height": image.get_height(),
        "layers": [{{"id": layer.get_id(), "name": layer.get_name()}} for layer in image.get_layers()],
    }}
"""
        ],
    )


@mcp.tool()
def apply_gaussian_blur(ctx: Context, image_id: int, radius: float = 5.0) -> str:
    """Apply Gaussian blur to an image.

    Parameters:
    - image_id: The ID of the image
    - radius: Blur radius

    Returns:
    - Success message or error
    """
    return call_api(
        ctx,
        "exec",
        args=[
            f"""
image = Gimp.Image.get_by_id({int(image_id)})
if image is None:
    _result = "image not found"
else:
    layers = image.get_layers()
    if not layers:
        _result = "no layers"
    else:
        drawable = layers[0]
        blur = Gimp.DrawableFilter.new(drawable, "gegl:gaussian-blur", "")
        cfg = blur.get_config()
        try:
            cfg.set_property("std-dev-x", {float(radius)})
            cfg.set_property("std-dev-y", {float(radius)})
        except Exception:
            pass
        drawable.append_filter(blur)
        drawable.merge_filter(blur)
        Gimp.displays_flush()
        _result = "Applied Gaussian blur successfully"
"""
        ],
    )


def main():
    mcp.run()


if __name__ == "__main__":
    main()
