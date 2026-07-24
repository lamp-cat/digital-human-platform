"""本地文件对象存储（STORAGE_BACKEND=local）。"""
from pathlib import Path


class LocalStorage:
    """以 key（正斜杠相对路径）存取二进制对象；根目录为 storage_local_dir。"""

    def __init__(self, root: str):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        # 防目录穿越
        path = (self.root / key).resolve()
        if not str(path).startswith(str(self.root)):
            raise ValueError("非法存储 key")
        return path

    def put(self, key: str, data: bytes) -> str:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return key

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def delete(self, key: str) -> None:
        path = self._path(key)
        if path.is_file():
            path.unlink()

    def delete_prefix(self, prefix: str) -> None:
        """删除某前缀目录下全部对象（用于导入删除的级联清理）。"""
        path = self._path(prefix)
        if path.is_dir():
            for child in sorted(path.rglob("*"), reverse=True):
                if child.is_file():
                    child.unlink()
                elif child.is_dir():
                    child.rmdir()
            path.rmdir()
        elif path.is_file():
            path.unlink()


def make_storage(backend: str, local_dir: str) -> LocalStorage:
    if backend != "local":
        # V1 仅实现 local；S3/MinIO 留待后续
        raise ValueError(f"暂不支持的存储后端: {backend}")
    return LocalStorage(local_dir)
