// Shared utilities for the density/telescope export pipeline.

function _writeNpy(typedArray, shape, dtype) {
  const dictBody  = `{'descr': '${dtype}', 'fortran_order': False, 'shape': (${shape.join(', ')},), }`;
  const baseLen   = 11 + dictBody.length;
  const pad       = (64 - (baseLen % 64)) % 64;
  const headerStr = dictBody + ' '.repeat(pad) + '\n';
  const headerLen = headerStr.length;
  const buf       = new ArrayBuffer(10 + headerLen + typedArray.byteLength);
  const bytes     = new Uint8Array(buf);
  const dv        = new DataView(buf);
  bytes[0]=0x93; bytes[1]=0x4E; bytes[2]=0x55;
  bytes[3]=0x4D; bytes[4]=0x50; bytes[5]=0x59;
  bytes[6]=0x01; bytes[7]=0x00;
  dv.setUint16(8, headerLen, true);
  for (let i = 0; i < headerLen; i++) bytes[10 + i] = headerStr.charCodeAt(i);
  bytes.set(
    new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength),
    10 + headerLen
  );
  return new Uint8Array(buf);
}

function _download(data, filename, mime) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a   = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
