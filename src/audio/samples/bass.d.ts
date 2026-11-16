/** Pacote gerado por scripts/build-instruments.cjs. */
export interface Zone {
  /** nota (MIDI) que esta zona cobre */
  key: number;
  /** intensidades (da mais fraca à mais forte) → repetições: [início, tamanho, nota gravada] no `data` */
  layers: [number, number, number][][];
}
export const manifest: Zone[];
/** arquivos Ogg Vorbis concatenados, em base64 */
export const data: string;
