import { leaveDemoForSignup } from "@/app/(app)/demo/actions";

/**
 * The strip across the top of every demo page.
 *
 * Said before anybody types, because the alternative is finding out on Save:
 * a visitor who fills in a whole invoice and then learns it went nowhere
 * feels tricked, where one who was told up front is just trying things out.
 */
export function DemoBanner() {
  return (
    <div className="border-b border-brand/20 bg-brand/6 print:hidden">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 lg:px-6">
        <p className="text-sm text-ink">
          <span className="font-medium">You’re looking around a demo business.</span>{" "}
          <span className="text-ink-muted">Nothing you do here is saved.</span>
        </p>
        <form action={leaveDemoForSignup}>
          <button
            type="submit"
            className="text-sm font-medium text-brand hover:underline"
          >
            Create your account
          </button>
        </form>
      </div>
    </div>
  );
}
