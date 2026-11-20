/** Pacote gerado por scripts/build-instruments.cjs. */
export interface Zone {
  /** nota (MIDI) que esta zona cobre */
  key: number;
  /**
   * intensidades (da mais fraca à mais forte) → repetições:
   * [início, tamanho, nota gravada, início do loop (s), fim do loop (s)] no `data`; o loop só existe
   * nos instrumentos que sustentam
   */
  layers: [number, number, number, number?, number?][][];
}
export const manifest: Zone[];
/** arquivos Ogg Vorbis concatenados, em base64 */
export const data: string;
