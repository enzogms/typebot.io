import { createAuthConfig } from "@/features/auth/helpers/createAuthConfig";
import { DashboardPage } from "@/features/dashboard/components/DashboardPage";
import type { User } from "@typebot.io/schemas/features/user/schema";
import type { GetServerSidePropsContext } from "next";
import { type Session, getServerSession } from "next-auth";

export default function Page() {
  return <DashboardPage />;
}

export const getServerSideProps = async (
  context: GetServerSidePropsContext,
) => {
  const session = (await getServerSession(
    context.req,
    context.res,
    createAuthConfig({}),
  )) as Session & { user: User };
  console.log("🚀 ~ session:", session);

  const preferredLanguagePath =
    session?.user?.preferredLanguage &&
    session.user.preferredLanguage !== context.defaultLocale
      ? session.user.preferredLanguage
      : context.locale !== context.defaultLocale
        ? context.locale
        : undefined;

  const callbackUrl = context.query.callbackUrl?.toString();
  const redirectPath =
    context.query.redirectPath?.toString() ??
    (callbackUrl
      ? new URL(callbackUrl).searchParams.get("redirectPath")
      : undefined);
  return redirectPath
    ? {
        redirect: {
          permanent: false,
          destination: preferredLanguagePath
            ? `/${preferredLanguagePath}/${redirectPath}`
            : `/${redirectPath}`,
        },
      }
    : { props: {} };
};
