import ProfileSurface from '@/components/profile/ProfileSurface';

export default async function OtherProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProfileSurface profileId={id} />;
}
