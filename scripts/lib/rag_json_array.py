"""Read pinned public JSON arrays one record at a time, without a full-file load."""
import json


def iter_array(path, chunk_size=262144, observations=None):
    decoder=json.JSONDecoder();buffer='';position=0;eof=False
    with path.open(encoding='utf-8') as stream:
        def fill():
            nonlocal buffer,position,eof
            buffer=buffer[position:];position=0
            chunk=stream.read(chunk_size);eof=not chunk;buffer+=chunk
            if observations is not None:
                observations['maxBufferedChars']=max(observations.get('maxBufferedChars',0),len(buffer))
        def token():
            nonlocal position
            while True:
                while position<len(buffer) and buffer[position].isspace():position+=1
                if position<len(buffer) or eof:return buffer[position:position+1]
                fill()
        if token()!='[':raise ValueError('Expected a JSON array')
        position+=1;first=True
        while True:
            if token()==']':
                if not first:raise ValueError('Trailing comma')
                position+=1;break
            while True:
                try:
                    value,end=decoder.raw_decode(buffer,position)
                    # A complete scalar prefix (for example1 of123) needs its delimiter.
                    if not eof and (end==len(buffer) or buffer[end] not in ',] \t\r\n'):
                        fill();continue
                    break
                except json.JSONDecodeError:
                    if eof:raise
                    fill()
            position=end;yield value
            next_token=token()
            if next_token==']':position+=1;break
            if next_token!=',':raise ValueError('Expected comma between records')
            position+=1;first=False
        if token():raise ValueError('Trailing content after JSON array')
