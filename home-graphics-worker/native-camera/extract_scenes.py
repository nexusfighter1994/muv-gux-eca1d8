"""Copy the qualified original pure scene module from the recipient's own base."""
import hashlib,sys
from pathlib import Path
EXPECTED='4b047b178e6508561bb3ac13ec6abcde8a24c9e07d7076fa3450b4d46db6fc55'
def extract(data):
    if hashlib.sha256(data).hexdigest()!=EXPECTED:raise ValueError('Native scenes source changed; requalification required')
    return data
if __name__=='__main__':Path(sys.argv[2]).write_bytes(extract(Path(sys.argv[1]).read_bytes()))
