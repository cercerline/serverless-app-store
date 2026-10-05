import { redirect } from "next/navigation";

/**
 * Stable "upload your app" entry point.
 *
 * The promo animation encodes this exact URL into a QR code. Anything printed,
 * recorded or screenshotted therefore has this path baked in permanently, so
 * **repoint the redirect below instead of re-recording the video** if the upload
 * flow ever moves (e.g. to /submit, a new domain, or a form provider).
 *
 * This deliberately uses a temporary redirect (307), not `permanentRedirect`
 * (308): browsers cache a 308 indefinitely, which would stop a later repoint
 * from reaching anyone who already scanned once -- exactly the trap this route
 * exists to avoid. The one extra round trip is worth keeping it changeable.
 *
 * Keep this path free of query strings and tracking: anything longer pushes the
 * QR to a higher version and makes it physically harder to scan.
 */
export default function UploadRedirect(): never {
  redirect("/register");
}
