# Separate resource meaning from supply and deployment

Takoserver keeps provider identity and commercial terms out of Takoform Forms: a Form
defines resource meaning, while an Offering names sellable supply and a Deployment
records one provider realization of a logical Resource. This permits several
Offerings for the same exact Form and several Deployments during migration without
changing the Resource or leaking provider-native IDs and credentials into its
declaration. Attachments, rather than embedded native bindings, connect Resources;
provider changes are explicit Migration operations rather than ordinary updates.
