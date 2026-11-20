// Image imports resolve to the URL Bun emits for the file.
declare module "*.webp" {
  const src: string;
  export default src;
}
