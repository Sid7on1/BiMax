"""Create-only, atomic JSON receipts for the external RAG benchmark."""
import json,os,tempfile
from pathlib import Path


def immutable_json(path: Path, value):
    """Publish a complete flushed receipt; never replace an earlier observation."""
    fd,name=tempfile.mkstemp(prefix='.'+path.name+'.',suffix='.pending',dir=path.parent)
    temporary=Path(name)
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as stream:
            json.dump(value,stream,indent=2)
            stream.write('\n');stream.flush();os.fsync(stream.fileno())
        # Same-directory link is atomic and fails if the immutable destination exists.
        os.link(temporary,path)
        temporary.unlink()
        directory=os.open(path.parent,os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)
