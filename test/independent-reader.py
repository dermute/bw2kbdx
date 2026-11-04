"""Independent reader check for the synthetic database produced by keepassxc.test.ts."""
import json
import sys
from pathlib import Path

from pykeepass import PyKeePass

directory = Path(sys.argv[1])
vault = json.loads((directory / "source.json").read_text())
db = PyKeePass(directory / "fixture.kdbx", password="synthetic-backup-password")
assert len(db.entries) == len(vault["items"]) + 1
login = next(e for e in db.entries if e.custom_properties.get("Bitwarden.ID") == "login-1")
assert login.url == "https://example.test/?x=1&y=2"
assert login.custom_properties["KP2A_URL_1"] == "https://other.example.test/login"
assert login.custom_properties["KP2A_URL_2"] == "androidapp://org.example.app"
assert login.password == vault["items"][0]["login"]["password"]
assert login.notes == vault["items"][0]["notes"]
attachments = {attachment.filename: attachment.data for attachment in login.attachments}
assert attachments["../same-name.bin"] == bytes([0, 1, 255, 128, 13, 10])
assert attachments["../same-name.bin [attachment-2]"] == b"second content"
assert attachments["bw2kbdx-attachments.json"] == b""
recovery = next(e for e in db.entries if e.title == "Original Bitwarden export")
assert json.loads(recovery.attachments[0].data) == vault
print("Independent PyKeePass verification passed")
