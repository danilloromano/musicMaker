/**
 * Base64 → bytes sem travar a interface: o navegador decodifica a data URL fora do JavaScript (um laço com
 * atob/charCodeAt em pacotes de vários MB segurava o thread principal por centenas de ms e atrasava a música).
 */
export async function b64bytes(data: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await (await fetch(`data:application/octet-stream;base64,${data}`)).arrayBuffer());
  } catch {
    const str = atob(data);
    const bin = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bin[i] = str.charCodeAt(i);
    return bin;
  }
}
