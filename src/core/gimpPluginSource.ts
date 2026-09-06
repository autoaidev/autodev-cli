// ---------------------------------------------------------------------------
// gimpPluginSource.ts — GENERATED. Do not edit by hand.
//
// Source of truth: media/gimp/gimp_mcp_server.py (GPL-3.0; see media/gimp/LICENSE).
// Regenerate with:  node scripts/gen-gimp-plugin-source.mjs  (runs in `npm run build`).
//
// This embeds the auto-start GIMP MCP plugin body as a string so the installer
// works even when bundled (VS Code extension esbuild) with no media file on disk.
// ---------------------------------------------------------------------------

/** sha256 (first 12 hex) of the canonical media/gimp/gimp_mcp_server.py. */
export const GIMP_PLUGIN_SOURCE_HASH = "93b608412db2";

/** Full body of the auto-start GIMP 3.x MCP plugin (media/gimp/gimp_mcp_server.py). */
export const GIMP_PLUGIN_SOURCE = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#
# gimp_mcp_server.py — AutoDev auto-start GIMP 3.x MCP bridge
#
# Derived from libreearth/gimp-mcp @49c46dd (GPL-3.0); modified by AutoDev to
# auto-start as a GIMP 3.x PERSISTENT extension. The upstream plugin registered a
# manual "<Image>/Filters/Development/ → Start MCP Server" ImageProcedure that the
# user had to click; this variant registers a PERSISTENT extension so GIMP starts
# the socket server automatically on launch — no menu click, no open image needed.
#
# The socket / command-marshalling logic (start_server, handle_client,
# execute_command, GLib.idle_add onto GIMP's main thread) is kept from upstream.
# ONLY the registration + run() model changed to PERSISTENT + defensive ordering.
#
# ---------------------------------------------------------------------------
# GIMP 3.x plugin layout (REQUIRED): this file must live at
#   <gimp-config>/<ver>/plug-ins/gimp_mcp_server/gimp_mcp_server.py
# i.e. inside a sub-folder whose name == this file's basename. A loose .py is
# IGNORED by GIMP 3.x. On Linux/macOS it must ALSO be executable (chmod 0o755).
# ---------------------------------------------------------------------------
#
# Copyright (C) 2023 libreearth (upstream, GPL-3.0)
# Modifications Copyright (C) 2025 AutoDev
#
# This program is free software: you can redistribute it and/or modify it under
# the terms of the GNU General Public License as published by the Free Software
# Foundation, either version 3 of the License, or (at your option) any later
# version.
#
# This program is distributed in the hope that it will be useful, but WITHOUT ANY
# WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
# PARTICULAR PURPOSE. See the GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License along with
# this program. If not, see <https://www.gnu.org/licenses/>. A copy is vendored
# next to this file as LICENSE.

import os
import sys
import json
import socket
import threading
import traceback
import datetime

import gi
gi.require_version('Gimp', '3.0')
from gi.repository import Gimp
from gi.repository import GLib


# ---------------------------------------------------------------------------
# Logging — an auto-start extension has NO console, so every diagnostic goes to
# a log file the user can read. We resolve it next to this plug-in first (always
# writable if the plug-in loaded at all), falling back to the GIMP config dir.
# Nothing here may raise: a logging failure must never stop GIMP from launching.
# ---------------------------------------------------------------------------
def _log_path():
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        return os.path.join(here, 'gimp-mcp-server.log')
    except Exception:
        try:
            return os.path.join(GLib.get_user_config_dir(), 'gimp-mcp-server.log')
        except Exception:
            return os.path.join(os.path.expanduser('~'), 'gimp-mcp-server.log')


_LOG_FILE = _log_path()


def log(msg):
    """Best-effort append to the log file AND stderr. Never raises."""
    line = '[%s] %s' % (datetime.datetime.now().isoformat(timespec='seconds'), msg)
    try:
        with open(_LOG_FILE, 'a', encoding='utf-8') as fh:
            fh.write(line + '\\n')
    except Exception:
        pass
    try:
        sys.stderr.write(line + '\\n')
    except Exception:
        pass


class MCPPlugin(Gimp.PlugIn):
    # ── Registration ──────────────────────────────────────────────────────
    def do_query_procedures(self):
        return ["plug-in-mcp-server-autostart"]

    def do_create_procedure(self, name):
        # PERSISTENT + no args + no menu = GIMP auto-starts this extension at
        # launch. Adding ANY argument, a menu label, or a menu path would turn
        # it back into a user-invoked plug-in and disable auto-start.
        procedure = Gimp.Procedure.new(
            self, name, Gimp.PDBProcType.PERSISTENT, self.run, None,
        )
        try:
            procedure.set_documentation(
                "AutoDev MCP server (auto-start)",
                "Auto-starts a localhost:9876 socket bridge so external MCP "
                "clients can drive GIMP. Derived from libreearth/gimp-mcp "
                "(GPL-3.0), modified by AutoDev to run as a PERSISTENT extension.",
                name,
            )
            procedure.set_attribution("AutoDev", "AutoDev (GPL-3.0)", "2025")
        except Exception as e:
            # Attribution/doc setters are cosmetic — never let a binding
            # mismatch here prevent the procedure from registering.
            log("do_create_procedure: non-fatal setter error: %s" % e)
        return procedure

    # ── Extension entry point ─────────────────────────────────────────────
    def run(self, procedure, config, run_data):
        """PERSISTENT extension entry point.

        DEFENSIVE ORDER (the brick-risk part): call persistent_ready() FIRST.
        Its ABSENCE is what hangs GIMP at startup, so it must run before
        anything that could throw. Everything after it is wrapped so a bind
        failure logs + degrades instead of taking GIMP core down with it.
        """
        # 1) Hand control back to GIMP core IMMEDIATELY so the UI keeps loading.
        try:
            procedure.persistent_ready()
            log("persistent_ready() OK — extension is live")
        except Exception as e:
            # A binding mismatch on this exact call is the known lock-up cause;
            # log it (do NOT re-raise) so GIMP still finishes launching.
            log("persistent_ready() FAILED (non-fatal): %s\\n%s"
                % (e, traceback.format_exc()))

        # 2) Start the socket server on a daemon thread. A bind failure (port in
        #    use, sandbox denial) MUST NOT crash the process or block launch.
        try:
            t = threading.Thread(target=self.start_server, daemon=True)
            t.start()
            log("MCP server thread started (listening on localhost:9876)")
        except Exception as e:
            log("failed to start MCP server thread (non-fatal): %s\\n%s"
                % (e, traceback.format_exc()))

        # 3) Keep this extension process alive for the whole GIMP session so the
        #    socket stays open and idle_add callbacks can marshal onto core.
        try:
            GLib.MainLoop().run()
        except Exception as e:
            log("main loop exited (non-fatal): %s" % e)

        # 4) Standard PERSISTENT success return.
        return procedure.new_return_values(Gimp.PDBStatusType.SUCCESS, GLib.Error())

    # ── Socket server (kept from upstream) ────────────────────────────────
    def start_server(self):
        host = 'localhost'
        port = 9876
        sock = None
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((host, port))
            sock.listen(1)
            log("server listening on %s:%d" % (host, port))
        except Exception as e:
            # Bind/listen failed (e.g. port already taken by Blender's MCP or a
            # second GIMP). Log + bail out of the thread; GIMP keeps running.
            log("bind/listen failed (non-fatal): %s\\n%s" % (e, traceback.format_exc()))
            try:
                if sock is not None:
                    sock.close()
            except Exception:
                pass
            return

        while True:
            try:
                client, addr = sock.accept()
                log("client connected: %s" % (addr,))
                threading.Thread(
                    target=self.handle_client, args=(client,), daemon=True,
                ).start()
            except Exception as e:
                log("accept error: %s" % e)
                break
        try:
            sock.close()
        except Exception:
            pass

    def handle_client(self, client):
        buffer = b''
        while True:
            try:
                data = client.recv(1024)
                if not data:
                    break
                buffer += data
                try:
                    command = json.loads(buffer.decode('utf-8'))
                    buffer = b''
                    # Marshal onto GIMP's main thread — the PDB is not thread-safe.
                    GLib.idle_add(self.execute_command, command, client)
                except json.JSONDecodeError:
                    # Partial frame — keep buffering until it parses.
                    continue
            except Exception as e:
                log("client error: %s" % e)
                break
        try:
            client.close()
        except Exception:
            pass

    def execute_command(self, command, client):
        """Runs on GIMP's main thread via idle_add. Guarded so a bad command or
        a wrong binding logs + returns an error frame rather than hanging."""
        response = {}
        try:
            cmd_type = command.get("type")
            params = command.get("params", {})

            if cmd_type == "call_api":
                api_path = params["api_path"]
                args = params.get("args", [])
                kwargs = params.get("kwargs", {})

                module = Gimp
                for part in api_path.split("."):
                    module = getattr(module, part)

                result = module(*args, **kwargs)

                if hasattr(result, "ID"):
                    result = {"id": result.ID}
                elif isinstance(result, list):
                    result = [self.serialize_gimp_object(item) for item in result]
                else:
                    result = str(result)

                response = {"status": "success", "result": result}
            else:
                response = {"status": "error", "message": "Unknown command: %s" % cmd_type}
        except Exception as e:
            response = {"status": "error", "message": str(e),
                        "traceback": traceback.format_exc()}

        try:
            client.sendall(json.dumps(response).encode('utf-8'))
        except Exception as e:
            log("failed to send response: %s" % e)
        return False  # one-shot idle callback

    def serialize_gimp_object(self, obj):
        try:
            if hasattr(obj, "ID"):
                return {"id": obj.ID, "type": obj.__class__.__name__}
        except Exception:
            pass
        return str(obj)


try:
    Gimp.main(MCPPlugin.__gtype__, sys.argv)
except Exception as _e:
    # If GIMP's main dispatch itself fails, log it — never let the plug-in
    # process take the launch down with an unhandled traceback.
    log("Gimp.main failed: %s\\n%s" % (_e, traceback.format_exc()))
`;
