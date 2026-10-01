/** The flame mark the app, the website and the docs share. */
export function Mark({ size = 32 }: { size?: number }) {
  return (
    <span className="mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd">
        <path d="M12 2c.6 3.2-1.2 4.6-2.6 6C7.6 9.6 6 11.3 6 14a6 6 0 0 0 12 0c0-2.5-1.2-4.3-2.6-6C13.7 6 12.6 4.4 12 2Zm0 8.6c1.2 1.4 2 2.4 2 3.6a2 2 0 1 1-4 0c0-1.2.8-2.2 2-3.6Z" />
      </svg>
    </span>
  )
}
