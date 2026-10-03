"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, ImagePlus, X } from "lucide-react";

import { submitServiceRequest } from "./actions";
import { Input, Label, Select, Textarea } from "@/components/ui/form";
import { downscaleImage } from "@/lib/downscale-image";
import { REQUEST_PHOTO_EDGE, REQUEST_PHOTO_LIMIT, REQUEST_TIMES } from "@/lib/service-request";

type Prefill = {
  name: string;
  email: string;
  phone: string;
  line1: string;
  city: string;
  state: string;
  postalCode: string;
};

/**
 * The form itself. Photos are shrunk here, on the phone, before anything is
 * sent: five straight off a camera would be too big for one upload.
 */
export function RequestForm({
  slug,
  businessName,
  brandColor,
  services,
  portalToken,
  prefill,
}: {
  slug: string;
  businessName: string;
  brandColor: string;
  services: string[];
  portalToken: string | null;
  prefill: Prefill | null;
}) {
  const [photos, setPhotos] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  async function addPhotos(list: FileList | null) {
    if (!list) return;
    const room = REQUEST_PHOTO_LIMIT - photos.length;
    const picked = [...list].filter((file) => file.type.startsWith("image/")).slice(0, Math.max(room, 0));
    const shrunk = await Promise.all(
      picked.map((file) => downscaleImage(file, { longEdge: REQUEST_PHOTO_EDGE, quality: 0.8, smallBytes: 600 * 1024 })),
    );
    setPhotos((current) => [...current, ...shrunk].slice(0, REQUEST_PHOTO_LIMIT));
  }

  function submit(form: HTMLFormElement) {
    setError(null);
    setFieldErrors({});
    const data = new FormData(form);
    data.delete("photo-picker");
    for (const photo of photos) data.append("photos", photo);
    if (portalToken) data.set("for", portalToken);

    startTransition(async () => {
      try {
        const result = await submitServiceRequest(slug, data);
        if (result.ok) {
          setDone(true);
          window.scrollTo({ top: 0, behavior: "smooth" });
        } else {
          setError(result.error ?? (result.fieldErrors ? "Check the highlighted fields." : "Something went wrong."));
          setFieldErrors(result.fieldErrors ?? {});
        }
      } catch {
        setError("That didn't go through. Check your connection and try again.");
      }
    });
  }

  if (done) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-card border border-line bg-surface px-6 py-12 text-center">
        <CheckCircle2 className="h-9 w-9" style={{ color: brandColor }} strokeWidth={1.75} />
        <p className="text-base font-semibold text-ink">Thank you — we have your request.</p>
        <p className="max-w-sm text-sm text-ink-muted">{businessName} will be in touch soon.</p>
      </div>
    );
  }

  const err = (key: string) =>
    fieldErrors[key] ? <p className="text-xs text-danger">{fieldErrors[key]}</p> : null;

  return (
    <form
      className="space-y-5 rounded-card border border-line bg-surface p-5 sm:p-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit(event.currentTarget);
      }}
    >
      {error ? (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {/* Hidden from people; a bot that fills it is quietly ignored. */}
      <div aria-hidden className="absolute -left-[9999px] h-0 overflow-hidden">
        <label>
          Leave this empty
          <input name="company_website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="name" required>Your name</Label>
          <Input id="name" name="name" autoComplete="name" defaultValue={prefill?.name} required />
          {err("name")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" name="phone" type="tel" autoComplete="tel" defaultValue={prefill?.phone} />
          {err("phone")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" defaultValue={prefill?.email} />
          {err("email")}
        </div>
      </div>

      {services.length > 0 ? (
        <div className="space-y-1.5">
          <Label htmlFor="service">What do you need?</Label>
          <Select id="service" name="service" defaultValue="">
            <option value="">Choose one, or describe it below</option>
            {services.map((service) => (
              <option key={service} value={service}>
                {service}
              </option>
            ))}
            <option value="Something else">Something else</option>
          </Select>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="description" required>Tell us about it</Label>
        <Textarea
          id="description"
          name="description"
          rows={4}
          required
          placeholder="What's going on, and anything we should know before we come out."
        />
        {err("description")}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">Where</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem_7rem]">
          <Input name="line1" aria-label="Street address" placeholder="Street address" autoComplete="street-address" defaultValue={prefill?.line1} className="sm:col-span-4" />
          <Input name="city" aria-label="City" placeholder="City" autoComplete="address-level2" defaultValue={prefill?.city} className="sm:col-span-2" />
          <Input name="state" aria-label="State" placeholder="State" autoComplete="address-level1" defaultValue={prefill?.state} />
          <Input name="postalCode" aria-label="ZIP code" placeholder="ZIP" autoComplete="postal-code" defaultValue={prefill?.postalCode} />
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">When suits you?</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input name="preferredDate" type="date" aria-label="Preferred date" />
          <Select name="preferredTime" defaultValue="ANY" aria-label="Preferred time of day">
            {REQUEST_TIMES.map((time) => (
              <option key={time.value} value={time.value}>
                {time.label}
              </option>
            ))}
          </Select>
        </div>
      </fieldset>

      <div className="space-y-2">
        <p className="text-sm font-medium text-ink">Photos (optional)</p>
        {photos.length > 0 ? (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {photos.map((photo, i) => (
              <li key={`${photo.name}-${i}`} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={URL.createObjectURL(photo)}
                  alt=""
                  className="aspect-square w-full rounded-lg border border-line object-cover"
                />
                <button
                  type="button"
                  onClick={() => setPhotos((current) => current.filter((_, j) => j !== i))}
                  className="absolute top-1 right-1 rounded-full bg-black/60 p-1 text-white"
                  aria-label="Remove photo"
                >
                  <X className="h-3 w-3" strokeWidth={2.5} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {photos.length < REQUEST_PHOTO_LIMIT ? (
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong px-4 py-4 text-sm text-ink-muted hover:bg-surface-2">
            <ImagePlus className="h-4 w-4" strokeWidth={1.75} />
            Add photos — up to {REQUEST_PHOTO_LIMIT}
            <input
              name="photo-picker"
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              onChange={(e) => {
                void addPhotos(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        ) : null}
      </div>

      <button
        type="submit"
        disabled={pending}
        style={{ backgroundColor: brandColor }}
        className="inline-flex h-11 w-full items-center justify-center rounded-lg px-5 text-sm font-medium text-white shadow-sm transition-[filter] hover:brightness-110 disabled:opacity-60 sm:w-auto"
      >
        {pending ? "Sending…" : "Send request"}
      </button>
    </form>
  );
}
