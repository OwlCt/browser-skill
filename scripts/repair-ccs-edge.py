"""Repair this machine's Edge MCP configuration without changing provider credentials."""

import argparse
import datetime
import json
import pathlib
import re
import shutil
import sqlite3
import subprocess
import tomllib

ROOT = pathlib.Path(__file__).resolve().parent.parent
USER = pathlib.Path.home()
CCS = USER / ".cc-switch"
DATABASE = CCS / "cc-switch.db"
LIVE = USER / ".codex" / "config.toml"
EDGE_ID = "responses_edge_browser"
NODE = pathlib.Path(r"C:\Program Files\nodejs\node.exe")
EDGE = {
    "command": str(NODE),
    "args": [str(ROOT / "src" / "mcp-server.mjs")],
    "cwd": str(ROOT),
    "enabled": True,
    "startup_timeout_sec": 30,
    "tool_timeout_sec": 120,
}
BLOCK = (
    "[mcp_servers.responses_edge_browser]\n"
    f"command = '{NODE}'\n"
    f"args = ['{ROOT / 'src' / 'mcp-server.mjs'}']\n"
    f"cwd = '{ROOT}'\n"
    "enabled = true\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\n"
)


def add_edge(text):
    before = tomllib.loads(text)
    existing = before.get("mcp_servers", {}).get(EDGE_ID)
    if existing is not None:
        if existing != EDGE:
            raise ValueError("Existing Edge MCP entry differs; inspect it before replacement")
        return text
    new = text + ("" if text.endswith("\n") else "\n") + "\n" + BLOCK
    after = tomllib.loads(new)
    assert after["mcp_servers"].pop(EDGE_ID) == EDGE
    if not after["mcp_servers"] and "mcp_servers" not in before:
        del after["mcp_servers"]
    assert after == before, "Unrelated TOML values changed"
    assert new.startswith(text), "Original bytes must stay unchanged"
    return new


def replace_config_json(raw, old_config, new_config):
    pattern = re.compile(r'("config"\s*:\s*)("(?:\\.|[^"\\])*")')
    matches = [m for m in pattern.finditer(raw) if json.loads(m.group(2)) == old_config]
    assert len(matches) == 1, "Expected one provider config field"
    match = matches[0]
    replacement = json.dumps(new_config, ensure_ascii=False)
    changed = raw[:match.start(2)] + replacement + raw[match.end(2):]
    old_doc, new_doc = json.loads(raw), json.loads(changed)
    old_doc.pop("config")
    assert new_doc.pop("config") == new_config
    assert old_doc == new_doc, "Provider fields outside config changed"
    # Prefix/suffix are copied verbatim, including any auth fields.
    assert changed[:match.start(2)] == raw[:match.start(2)]
    assert changed[match.start(2) + len(replacement):] == raw[match.end(2):]
    return changed


def ccs_is_running():
    result = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq cc-switch.exe", "/FO", "CSV", "/NH"],
        capture_output=True, check=True,
    )
    return b'"cc-switch.exe"' in result.stdout.lower()


def main():
    args = argparse.ArgumentParser()
    args.add_argument("--apply", action="store_true")
    options = args.parse_args()
    assert NODE.is_file() and pathlib.Path(EDGE["args"][0]).is_file()
    assert DATABASE.is_file() and LIVE.is_file()
    con = sqlite3.connect(DATABASE.as_uri() + ("?mode=rw" if options.apply else "?mode=ro"), uri=True)
    if not options.apply:
        con.execute("PRAGMA query_only=ON")
    old_common = con.execute("SELECT value FROM settings WHERE key='common_config_codex'").fetchone()[0]
    common = add_edge(old_common)
    provider_updates = []
    for provider_id, config in con.execute(
        "SELECT id,json_extract(settings_config,'$.config') FROM providers WHERE app_type='codex'"
    ):
        assert isinstance(config, str)
        provider_updates.append((provider_id, config, add_edge(config)))

    live_bytes = LIVE.read_bytes()
    live_text = live_bytes.decode("utf-8-sig")
    new_live = add_edge(live_text)
    # Appending keeps even a possible BOM and all protected bytes intact.
    new_live_bytes = live_bytes + new_live[len(live_text):].encode("utf-8")
    assert new_live_bytes.startswith(live_bytes)
    asset_root = ROOT / "scripts" / "repair-assets" / "responses-edge-browser"
    assets = {
        "SKILL.md": (asset_root / "SKILL.md").read_bytes(),
        "references/provider-compatibility.md": (ROOT / ".codex" / "skills" / "responses-edge-browser" / "references" / "provider-compatibility.md").read_bytes(),
        "agents/openai.yaml": (ROOT / ".codex" / "skills" / "responses-edge-browser" / "agents" / "openai.yaml").read_bytes(),
    }
    targets = [
        CCS / "skills" / "responses-edge-browser",
        USER / ".cursor" / "skills" / "responses-edge-browser",
        ROOT / ".codex" / "skills" / "responses-edge-browser",
    ]
    summary = {
        "common_config_needs_update": common != old_common,
        "codex_provider_count": len(provider_updates),
        "providers_needing_update": sum(old != new for _, old, new in provider_updates),
        "live_config_needs_update": new_live_bytes != live_bytes,
        "shared_skill_targets": [str(p) for p in targets],
        "registry_enable_codex": True,
    }
    if not options.apply:
        print(json.dumps(summary, ensure_ascii=False))
        con.close()
        return
    assert not ccs_is_running(), "Stop CC Switch before updating its persistent configuration"
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = CCS / "backups" / ("edge-mcp-repair-" + stamp)
    backup.mkdir(parents=True, exist_ok=False)
    backup_con = sqlite3.connect(backup / "cc-switch.db")
    con.backup(backup_con)
    backup_con.close()
    shutil.copy2(LIVE, backup / "codex-config.toml")
    manifest = {"live_config": str(LIVE), "files": []}
    planned_files = []
    for index, target in enumerate(targets):
        for relative, payload in assets.items():
            filename = target / relative
            if filename.exists():
                saved = backup / ("skill-" + str(index)) / relative
                saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(filename, saved)
                manifest["files"].append({"target": str(filename), "backup": str(saved)})
            else:
                manifest["files"].append({"target": str(filename), "backup": None})
            planned_files.append((filename, payload))
    (backup / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    assert con.execute("PRAGMA quick_check").fetchone() == ("ok",)
    con.execute("BEGIN IMMEDIATE")
    written = []
    try:
        con.execute("UPDATE settings SET value=? WHERE key='common_config_codex'", (common,))
        for provider_id, old, new in provider_updates:
            if old == new:
                continue
            raw = con.execute("SELECT settings_config FROM providers WHERE app_type='codex' AND id=?", (provider_id,)).fetchone()[0]
            changed = replace_config_json(raw, old, new)
            con.execute("UPDATE providers SET settings_config=? WHERE app_type='codex' AND id=?", (changed, provider_id))
        server_config = {"type": "stdio", **{key: value for key, value in EDGE.items() if key != "enabled"}}
        con.execute(
            "INSERT INTO mcp_servers(id,name,server_config,description,enabled_codex) VALUES(?,?,?,?,1) "
            "ON CONFLICT(id) DO UPDATE SET server_config=excluded.server_config,enabled_codex=1",
            (EDGE_ID, EDGE_ID, json.dumps(server_config), "Dedicated local Microsoft Edge browser MCP"),
        )
        description = assets["SKILL.md"].decode("utf-8").split("description: ", 1)[1].split("\n", 1)[0]
        con.execute(
            "UPDATE skills SET description=?,content_hash=NULL,updated_at=? WHERE id='local:responses-edge-browser'",
            (description, int(datetime.datetime.now(datetime.timezone.utc).timestamp())),
        )
        assert LIVE.read_bytes() == live_bytes, "Codex config changed during repair; retry safely"
        assert not ccs_is_running(), "CC Switch restarted during repair"
        LIVE.write_bytes(new_live_bytes)
        for filename, payload in planned_files:
            filename.parent.mkdir(parents=True, exist_ok=True)
            written.append(filename)
            filename.write_bytes(payload)
        con.commit()
    except BaseException:
        con.rollback()
        shutil.copy2(backup / "codex-config.toml", LIVE)
        for entry in manifest["files"]:
            target = pathlib.Path(entry["target"])
            if target not in written:
                continue
            if entry["backup"]:
                shutil.copy2(entry["backup"], target)
            else:
                target.unlink(missing_ok=True)
        raise
    assert con.execute("PRAGMA quick_check").fetchone() == ("ok",)
    con.close()
    summary.update({"applied": True, "backup_directory": str(backup), "integrity": "ok"})
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
