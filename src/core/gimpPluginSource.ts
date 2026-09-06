// ---------------------------------------------------------------------------
// gimpPluginSource.ts — GENERATED. Do not edit by hand.
//
// Source of truth: media/gimp/gimp_mcp_server.py (GPL-3.0; see media/gimp/LICENSE).
// Regenerate with:  node scripts/gen-gimp-plugin-source.mjs  (runs in `npm run build`).
//
// Embeds the user-verified GIMP 3.x MCP server plug-in as a string so the installer works even when bundled
// (VS Code extension esbuild) with no media file on disk.
// ---------------------------------------------------------------------------

/** sha256 (first 12 hex) of the canonical media/gimp/gimp_mcp_server.py. */
export const GIMP_PLUGIN_SOURCE_HASH = "882fdb94b5c9";

/** Full body of the user-verified GIMP 3.x MCP server plug-in (media/gimp/gimp_mcp_server.py). */
export const GIMP_PLUGIN_SOURCE = `#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# gimp_mcp_server.py — vendored, USER-VERIFIED GIMP 3.2 MCP bridge (plug-in).
#
# Derived from libreearth/gimp-mcp (GPL-3.0; see media/gimp/LICENSE) and fixed by
# the user / AutoDev for GIMP 3.2 (Store / MSIX). Verified working on real GIMP
# 3.2.44: a menu-triggered PLUGIN (Tools -> MCP / Filters -> Development -> Start
# MCP Server) that listens on 127.0.0.1:9877 and drives GIMP. Keep the "GIMP MCP
# Server" window open — GLib.MainLoop() holds the out-of-process plug-in alive.
#
# This is the user's verified file; the body below is kept byte-for-byte. The
# lines in THIS block are a provenance comment only — do not edit the code below.
# ---------------------------------------------------------------------------

# GIMP MCP Server Plugin (GIMP 3.2)
# Listens on localhost:9877 so it does not collide with Blender MCP (9876).

import gi
gi.require_version('Gimp', '3.0')
from gi.repository import Gimp
from gi.repository import GLib
from gi.repository import Gio
from gi.repository import GObject

import io
import json
import os
import socket
import sys
import threading
import traceback

HOST = '127.0.0.1'
PORT = 9877
# Store GIMP redirects GLib config dir into the MSIX LocalCache. Also write
# to the real roaming profile so the log is findable.
_LOG_PATHS = [
    os.path.join(GLib.get_user_config_dir(), 'GIMP', '3.2', 'gimp_mcp_server.log'),
    os.path.join(os.environ.get('APPDATA', ''), 'GIMP', '3.2', 'gimp_mcp_server.log'),
]

_server_lock = threading.Lock()
_server_started = False
_exec_globals = None
_main_loop = None


def _log(msg):
    line = msg.rstrip() + '\\n'
    for path in _LOG_PATHS:
        if not path:
            continue
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'a', encoding='utf-8') as fh:
                fh.write(line)
        except Exception:
            pass
    print(msg, flush=True)


def N_(message):
    return message


def _(message):
    return GLib.dgettext(None, message)


def _serialize(obj):
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, (list, tuple)):
        return [_serialize(item) for item in obj]
    if isinstance(obj, dict):
        return {str(k): _serialize(v) for k, v in obj.items()}
    data = {'type': obj.__class__.__name__}
    if hasattr(obj, 'get_id'):
        try:
            data['id'] = int(obj.get_id())
        except Exception:
            pass
    elif hasattr(obj, 'ID'):
        data['id'] = obj.ID
    if hasattr(obj, 'get_name'):
        try:
            data['name'] = obj.get_name()
        except Exception:
            pass
    if 'id' not in data and len(data) == 1:
        return str(obj)
    return data


def _resolve_api(api_path):
    parts = [p for p in str(api_path).split('.') if p]
    if parts and parts[0] == 'Gimp':
        parts = parts[1:]
    elif len(parts) >= 3 and parts[0] == 'gi' and parts[1] == 'repository' and parts[2] == 'Gimp':
        parts = parts[3:]

    aliases = {
        'list_images': 'get_images',
        'list_fonts': 'get_fonts',
        'fonts_get_list': 'get_fonts',
    }

    if not parts:
        return Gimp

    obj = Gimp
    for part in parts:
        part = aliases.get(part, part)
        obj = getattr(obj, part)
    return obj


def _exec_namespace():
    global _exec_globals
    if _exec_globals is None:
        ns = {
            '__builtins__': __builtins__,
            '__name__': '__main__',
            'Gimp': Gimp,
            'GLib': GLib,
            'Gio': Gio,
            'GObject': GObject,
            'sys': sys,
            'os': os,
            'json': json,
        }
        try:
            gi.require_version('Gegl', '0.4')
            from gi.repository import Gegl
            ns['Gegl'] = Gegl
        except Exception as exc:
            _log(f'Gegl import failed: {exc}')
        try:
            gi.require_version('Babl', '0.1')
            from gi.repository import Babl
            ns['Babl'] = Babl
        except Exception:
            pass
        _exec_globals = ns
    return _exec_globals


def _extract_code(args, kwargs):
    if kwargs.get('code'):
        return str(kwargs['code'])
    if not args:
        return ''
    if len(args) >= 2 and args[0] in ('exec', 'eval', 'pyGObject-console'):
        payload = args[1]
        if isinstance(payload, (list, tuple)):
            return '\\n'.join(str(item) for item in payload)
        return str(payload)
    if isinstance(args[0], (list, tuple)):
        return '\\n'.join(str(item) for item in args[0])
    return str(args[0])


def _run_python(code):
    ns = _exec_namespace()
    stdout = io.StringIO()
    old_stdout = sys.stdout
    sys.stdout = stdout
    try:
        exec(code, ns)
    finally:
        sys.stdout = old_stdout
    printed = stdout.getvalue()
    result = ns.get('_result')
    if result is not None:
        return {'printed': printed, 'result': _serialize(result)}
    return {'printed': printed, 'result': None}


class MCPPlugin(Gimp.PlugIn):
    def do_set_i18n(self, name):
        return False

    def do_query_procedures(self):
        return ['plug-in-mcp-server']

    def do_create_procedure(self, name):
        procedure = Gimp.Procedure.new(
            self, name, Gimp.PDBProcType.PLUGIN, self.run, None
        )
        procedure.set_menu_label(_('Start MCP Server'))
        procedure.set_documentation(
            _('Starts an MCP server to control GIMP externally'),
            _('Listens on 127.0.0.1:9877 for the GIMP MCP client'),
            name,
        )
        procedure.set_attribution('GIMP MCP', 'GIMP MCP', '2026')
        procedure.set_sensitivity_mask(Gimp.ProcedureSensitivityMask.ALWAYS)
        procedure.add_enum_argument(
            'run-mode',
            _('Run mode'),
            _('The run mode'),
            Gimp.RunMode,
            Gimp.RunMode.INTERACTIVE,
            GObject.ParamFlags.READWRITE,
        )
        procedure.add_menu_path('<Image>/Tools/MCP')
        procedure.add_menu_path('<Image>/Filters/Development/')
        return procedure

    def run(self, procedure, config, data):
        global _main_loop
        started, message = self.ensure_server()
        _log(message)
        if not started:
            return procedure.new_return_values(Gimp.PDBStatusType.EXECUTION_ERROR, GLib.Error(message))

        # GIMP 3 launches Python plug-ins out of process. Returning from run()
        # would exit that process and kill the socket thread. Stay alive and
        # dispatch GLib.idle_add work (API calls) on this main loop.
        # A visible window is required: otherwise "Start MCP Server" looks like
        # it did not open anything.
        try:
            self._show_status_window(message)
        except Exception as exc:
            _log(f'Status window failed: {exc}\\n{traceback.format_exc()}')

        _main_loop = GLib.MainLoop()
        _log('Entering GLib.MainLoop to keep MCP server process alive')
        try:
            _main_loop.run()
        except Exception as exc:
            _log(f'MainLoop exited: {exc}')
        return procedure.new_return_values(Gimp.PDBStatusType.SUCCESS, GLib.Error())

    def _show_status_window(self, message):
        gi.require_version('Gtk', '3.0')
        gi.require_version('GimpUi', '3.0')
        from gi.repository import Gtk
        from gi.repository import GimpUi

        GimpUi.init('gimp_mcp_server.py')
        window = Gtk.Window(title='GIMP MCP Server')
        window.set_default_size(360, 120)
        window.set_keep_above(False)
        window.set_skip_taskbar_hint(False)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        box.set_border_width(16)
        label = Gtk.Label(label=message + '\\nLeave this window open.')
        label.set_line_wrap(True)
        box.pack_start(label, True, True, 0)
        button = Gtk.Button(label='Stop server')
        button.connect('clicked', lambda *_: window.destroy())
        box.pack_start(button, False, False, 0)
        window.add(box)
        window.connect('destroy', self._on_status_closed)
        window.show_all()
        _log('Status window opened')

    def _on_status_closed(self, *_args):
        global _main_loop
        _log('Status window closed; stopping MCP server')
        if _main_loop is not None:
            _main_loop.quit()

    def ensure_server(self):
        global _server_started
        with _server_lock:
            if _server_started:
                return True, f'MCP Server already listening on {HOST}:{PORT}'
            try:
                thread = threading.Thread(target=self.start_server, daemon=True)
                thread.start()
                _server_started = True
                return True, f'MCP Server started on {HOST}:{PORT}'
            except Exception as exc:
                return False, f'Failed to start MCP Server: {exc}'

    def start_server(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((HOST, PORT))
            sock.listen(8)
            _log(f'Server listening on {HOST}:{PORT}')
        except Exception as exc:
            _log(f'Bind/listen failed: {exc}')
            return

        while True:
            try:
                client, addr = sock.accept()
                _log(f'Connected to {addr}')
                threading.Thread(target=self.handle_client, args=(client,), daemon=True).start()
            except Exception as exc:
                _log(f'Server accept error: {exc}')
                break
        sock.close()

    def handle_client(self, client):
        buffer = b''
        try:
            client.settimeout(120)
            while True:
                chunk = client.recv(65536)
                if not chunk:
                    break
                buffer += chunk
                while buffer:
                    try:
                        command = json.loads(buffer.decode('utf-8'))
                        buffer = b''
                    except json.JSONDecodeError:
                        break
                    GLib.idle_add(self.execute_command, command, client)
        except Exception as exc:
            _log(f'Client error: {exc}')
        finally:
            try:
                client.close()
            except Exception:
                pass

    def execute_command(self, command, client):
        cmd_type = command.get('type')
        params = command.get('params', {}) or {}
        try:
            if cmd_type == 'ping':
                response = {'status': 'success', 'result': 'pong'}
            elif cmd_type == 'exec':
                code = _extract_code(params.get('args', []), params.get('kwargs', {}))
                if not code:
                    code = str(params.get('code', ''))
                response = {'status': 'success', 'result': _run_python(code)}
            elif cmd_type == 'call_api':
                api_path = params.get('api_path', '')
                args = params.get('args', []) or []
                kwargs = params.get('kwargs', {}) or {}
                if api_path in ('exec', 'eval', '__exec__'):
                    response = {'status': 'success', 'result': _run_python(_extract_code(args, kwargs))}
                else:
                    method = _resolve_api(api_path)
                    result = method(*args, **kwargs)
                    response = {'status': 'success', 'result': _serialize(result)}
            else:
                response = {'status': 'error', 'message': f'Unknown command: {cmd_type}'}
        except Exception as exc:
            response = {
                'status': 'error',
                'message': str(exc),
                'traceback': traceback.format_exc(),
            }
            _log(f'Command error: {response["message"]}\\n{response["traceback"]}')

        try:
            payload = json.dumps(response).encode('utf-8')
            client.sendall(payload)
        except Exception as exc:
            _log(f'Response send failed: {exc}')
        return False


Gimp.main(MCPPlugin.__gtype__, sys.argv)
`;
