// What a check imports with `?raw`: a file's source as it is written, which Vite hands over in Node and in a window.
declare module '*?raw' {
  const source: string
  export default source
}
