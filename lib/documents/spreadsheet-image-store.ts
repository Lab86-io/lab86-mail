/** Images live in the private workbook snapshot, including earlier revisions. */
export const MAX_SPREADSHEET_IMAGE_BYTES = 400_000;
const imageType = /^image\/(?:avif|bmp|gif|vnd\.microsoft\.icon|jpeg|png|tiff|webp)$/u;

export const spreadsheetImageStore = {
  async upload(file: Blob): Promise<string> {
    if (!imageType.test(file.type)) throw new Error('Choose a supported image such as PNG or JPEG.');
    if (file.size > MAX_SPREADSHEET_IMAGE_BYTES)
      throw new Error('Choose an image smaller than 400 KB to fit in this workbook.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return `data:${file.type};base64,${btoa(binary)}`;
  },
  async delete(_path: string): Promise<void> {
    /* Prior versions retain their images. */
  },
  async getFile(path: string): Promise<Blob> {
    const response = await fetch(path);
    if (!response.ok) throw new Error('The spreadsheet image could not be loaded.');
    return response.blob();
  },
};
