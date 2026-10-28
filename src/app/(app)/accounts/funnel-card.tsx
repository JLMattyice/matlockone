import { Card, CardHeader } from "@/components/ui/card";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import {
  FUNNEL_META,
  FUNNEL_STEPS,
  shareOf,
  type FunnelColumn,
} from "@/lib/signup-funnel";

/**
 * How far the businesses that sign up get, on the Accounts page. The website
 * visits before the sign-up form are in Vercel Web Analytics, which this
 * points to rather than repeats.
 */
export function FunnelCard({ columns, showDemo }: { columns: FunnelColumn[]; showDemo: boolean }) {
  // A phone has room for two columns beside the steps: the month and all time.
  const fits = (key: string) => (key === "week" ? "hidden sm:table-cell" : "");

  return (
    <Card id="funnel">
      <CardHeader
        title="Sign-up funnel"
        description="Of the businesses that signed up in each period, how many got to each step. Visits to the website — how many people came, where from, and which pages they opened — are in Vercel, under Analytics."
      />
      <Table>
        <THead>
          <Th>Step</Th>
          {columns.map(({ window }) => (
            <Th key={window.key} align="right" className={`whitespace-nowrap ${fits(window.key)}`}>
              {window.label}
            </Th>
          ))}
        </THead>
        <TBody>
          {FUNNEL_STEPS.map((step) => (
            <Tr key={step}>
              <Td>
                <span className="block font-medium">{FUNNEL_META[step].label}</span>
                <span className="hidden text-xs text-ink-subtle sm:block">{FUNNEL_META[step].hint}</span>
              </Td>
              {columns.map(({ window, reached }) => {
                const share = step === "signed-up" ? null : shareOf(reached[step], reached["signed-up"]);
                return (
                  <Td key={window.key} align="right" className={`tabular whitespace-nowrap ${fits(window.key)}`}>
                    <span className="font-medium">{reached[step]}</span>
                    {share ? <span className="ml-1.5 text-xs text-ink-subtle">{share}</span> : null}
                  </Td>
                );
              })}
            </Tr>
          ))}
          {showDemo ? (
            <Tr>
              <Td>
                <span className="block font-medium text-ink-muted">Signed in to the demo</span>
                <span className="hidden text-xs text-ink-subtle sm:block">
                  Every sign-in to the demo workspace, whether or not they went on to sign up.
                </span>
              </Td>
              {columns.map(({ window, demoSignIns }) => (
                <Td key={window.key} align="right" className={`tabular text-ink-muted ${fits(window.key)}`}>
                  {demoSignIns}
                </Td>
              ))}
            </Tr>
          ) : null}
        </TBody>
      </Table>
    </Card>
  );
}
