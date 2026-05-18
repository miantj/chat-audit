import keyring
import json
import os
from typing import Tuple, Optional
from cryptography.fernet import Fernet

class CredentialManager:
    SERVICE: str = "ChatAuditExport"

    def _get_key_file_path(self) -> str:
        if os.name == "nt":
            base = os.environ.get("APPDATA", os.path.expanduser("~"))
        else:
            base = os.path.expanduser("~/.config")
        return os.path.join(base, "chat-audit-export", ".key")

    @property
    def key_file(self) -> str:
        return self._get_key_file_path()

    def _get_cipher(self) -> Fernet:
        key_file = self._get_key_file_path()
        if not os.path.exists(key_file):
            key = Fernet.generate_key()
            os.makedirs(os.path.dirname(key_file), exist_ok=True)
            with open(key_file, "wb") as f:
                f.write(key)
            os.chmod(key_file, 0o600)
        else:
            with open(key_file, "rb") as f:
                key = f.read()
        return Fernet(key)

    def save(self, username: str, password: str) -> None:
        cipher = self._get_cipher()
        data = json.dumps({"username": username, "password": password})
        encrypted = cipher.encrypt(data.encode())
        keyring.set_password(self.SERVICE, "credentials", encrypted.decode())

    def load(self) -> Tuple[Optional[str], Optional[str]]:
        try:
            encrypted = keyring.get_password(self.SERVICE, "credentials")
            if not encrypted:
                return None, None
            cipher = self._get_cipher()
            data = cipher.decrypt(encrypted.encode())
            parsed = json.loads(data)
            return parsed["username"], parsed["password"]
        except Exception:
            return None, None

    def delete(self) -> None:
        try:
            keyring.delete_password(self.SERVICE, "credentials")
        except Exception:
            pass