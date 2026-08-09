import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProviderStatus } from "../../platform/contracts";
import {
  IntelligenceWorkspace,
  ProviderPaidCallsControl,
} from "./CompetitorSearchPage";

const status: ProviderStatus = {
  provider: "native-provider",
  state: "configured",
  paidCallsEnabled: false,
  costCeilingAud: "0.00",
  costCeilingCents: 0,
  costPerCallCents: 0,
  spentCents: 0,
  credentialConfigured: false,
  credentialHint: null,
  lastValidatedAt: null,
};

describe("provider paid-call control", () => {
  it("stays disabled until validation and an explicit bounded budget are supplied", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(
      <ProviderPaidCallsControl status={status} onToggle={onToggle} />,
    );

    const unavailable = screen.getByRole("button", {
      name: /enable paid provider calls within budget/i,
    });
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveAttribute("aria-pressed", "false");

    rerender(
      <ProviderPaidCallsControl
        status={{ ...status, credentialConfigured: true }}
        onToggle={onToggle}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      /validate the protected credential/i,
    );

    rerender(
      <ProviderPaidCallsControl
        status={{
          ...status,
          credentialConfigured: true,
          lastValidatedAt: "2026-08-09T00:00:00.000Z",
        }}
        onToggle={onToggle}
      />,
    );
    await user.type(
      screen.getByRole("textbox", { name: /total provider budget/i }),
      "10.00",
    );
    await user.type(
      screen.getByRole("textbox", { name: /reserved cost per call/i }),
      "0.05",
    );
    const enable = screen.getByRole("button", {
      name: /enable paid provider calls within budget/i,
    });
    expect(enable).toBeEnabled();
    await user.click(enable);
    expect(onToggle).toHaveBeenLastCalledWith(true, 1_000, 5);

    rerender(
      <ProviderPaidCallsControl
        status={{
          ...status,
          credentialConfigured: true,
          lastValidatedAt: "2026-08-09T00:00:00.000Z",
          paidCallsEnabled: true,
          costCeilingAud: "10.00",
          costCeilingCents: 1_000,
          costPerCallCents: 5,
          spentCents: 5,
        }}
        onToggle={onToggle}
      />,
    );
    const disable = screen.getByRole("button", {
      name: /disable paid provider calls/i,
    });
    expect(disable).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      /AUD 0.05 reserved of AUD 10.00/i,
    );
    await user.click(disable);
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });
});

describe("fixture intelligence workspace", () => {
  it("labels its controls as session-only previews and gives review actions real visible state", async () => {
    const user = userEvent.setup();
    render(<IntelligenceWorkspace />);

    expect(screen.getByRole("note")).toHaveTextContent(
      /synthetic illustrative fixture/i,
    );
    await user.click(
      screen.getByRole("button", { name: /preview accepted state/i }),
    );
    expect(
      screen.getByRole("button", { name: /preview accepted state/i }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("accepted")).toBeInTheDocument();
  });
});
