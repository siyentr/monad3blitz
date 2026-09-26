const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const secretOf = (label) => ethers.id(`secret-${label}`);
const commitmentOf = (courseId, student, secret) =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address", "bytes32"], [courseId, student, secret]));

describe("CourseRegistration", function () {
  async function deployFixture() {
    const [admin, alice, bob, carol, outsider, ...rest] = await ethers.getSigners();
    const Reg = await ethers.getContractFactory("CourseRegistration");
    const reg = await Reg.deploy();

    await reg.addStudents([alice.address, bob.address, carol.address]);
    await reg.addCourse("CENG101", "Intro to Programming", 6, 2); // id 0
    await reg.addCourse("MATH101", "Calculus I", 8, 10); // id 1
    await reg.addCourse("PHYS101", "Physics I", 20, 10); // id 2

    const now = await time.latest();
    const start = now + 3600;
    const applyEnd = start + 300;
    const revealEnd = applyEnd + 300;
    await reg.setSchedule(start, applyEnd, revealEnd);

    // Student applies to a course with a secret derived from their address
    const apply = (student, courseId) =>
      reg.connect(student).applyFor(courseId, commitmentOf(courseId, student.address, secretOf(student.address)));

    return { reg, admin, alice, bob, carol, outsider, rest, start, applyEnd, revealEnd, apply };
  }

  async function openFixture() {
    const f = await deployFixture();
    await time.increaseTo(f.start);
    return f;
  }

  describe("Setup", function () {
    it("gives every student 30 AKTS", async function () {
      const { reg, alice, outsider } = await loadFixture(deployFixture);
      expect(await reg.balanceOf(alice.address)).to.equal(30);
      expect(await reg.balanceOf(outsider.address)).to.equal(0);
      expect(await reg.totalSupply()).to.equal(90);
      expect(await reg.studentCount()).to.equal(3);
    });

    it("rejects duplicate students", async function () {
      const { reg, alice } = await loadFixture(deployFixture);
      await expect(reg.addStudents([alice.address]))
        .to.be.revertedWithCustomError(reg, "AlreadyStudent")
        .withArgs(alice.address);
    });

    it("only admin can set up", async function () {
      const { reg, alice, outsider } = await loadFixture(deployFixture);
      await expect(reg.connect(alice).addStudents([outsider.address])).to.be.revertedWithCustomError(reg, "NotAdmin");
      await expect(reg.connect(alice).addCourse("X", "X", 1, 1)).to.be.revertedWithCustomError(reg, "NotAdmin");
    });

    it("validates course params", async function () {
      const { reg } = await loadFixture(deployFixture);
      await expect(reg.addCourse("X", "X", 0, 1)).to.be.revertedWithCustomError(reg, "InvalidParams");
      await expect(reg.addCourse("X", "X", 31, 1)).to.be.revertedWithCustomError(reg, "InvalidParams");
      await expect(reg.addCourse("X", "X", 5, 0)).to.be.revertedWithCustomError(reg, "InvalidParams");
    });

    it("can remove a student before registration opens", async function () {
      const { reg, carol } = await loadFixture(deployFixture);
      await reg.removeStudent(carol.address);
      expect(await reg.isStudent(carol.address)).to.equal(false);
      expect(await reg.balanceOf(carol.address)).to.equal(0);
      expect(await reg.totalSupply()).to.equal(60);
    });

    it("locks all admin setup once applications open", async function () {
      const { reg, alice, outsider, revealEnd } = await loadFixture(openFixture);
      await expect(reg.addStudents([outsider.address])).to.be.revertedWithCustomError(reg, "SetupLocked");
      await expect(reg.removeStudent(alice.address)).to.be.revertedWithCustomError(reg, "SetupLocked");
      await expect(reg.addCourse("X", "X", 5, 5)).to.be.revertedWithCustomError(reg, "SetupLocked");
      await expect(reg.updateCourse(0, 5, 100)).to.be.revertedWithCustomError(reg, "SetupLocked");
      await expect(reg.setSchedule(revealEnd + 10, revealEnd + 20, revealEnd + 30)).to.be.revertedWithCustomError(
        reg,
        "SetupLocked"
      );
    });

    it("validates the schedule", async function () {
      const { reg, start } = await loadFixture(deployFixture);
      await expect(reg.setSchedule(start, start, start + 10)).to.be.revertedWithCustomError(reg, "InvalidWindow");
      await expect(reg.setSchedule(start, start + 10, start + 10)).to.be.revertedWithCustomError(reg, "InvalidWindow");
    });
  });

  describe("AKTS is soulbound", function () {
    it("cannot be transferred or approved", async function () {
      const { reg, alice, bob } = await loadFixture(deployFixture);
      await expect(reg.connect(alice).transfer(bob.address, 1)).to.be.revertedWithCustomError(reg, "Soulbound");
      await expect(reg.connect(alice).approve(bob.address, 1)).to.be.revertedWithCustomError(reg, "Soulbound");
      await expect(reg.connect(bob).transferFrom(alice.address, bob.address, 1)).to.be.revertedWithCustomError(
        reg,
        "Soulbound"
      );
    });
  });

  describe("Apply", function () {
    it("is closed before and after the apply window", async function () {
      const { reg, alice, apply, applyEnd } = await loadFixture(deployFixture);
      expect(await reg.phase()).to.equal(0);
      await expect(apply(alice, 0)).to.be.revertedWithCustomError(reg, "WrongPhase");
      await time.increaseTo(applyEnd);
      expect(await reg.phase()).to.equal(2);
      await expect(apply(alice, 0)).to.be.revertedWithCustomError(reg, "WrongPhase");
    });

    it("stores the commitment and reserves AKTS", async function () {
      const { reg, alice, apply } = await loadFixture(openFixture);
      const c = commitmentOf(1, alice.address, secretOf(alice.address));
      await expect(apply(alice, 1)).to.emit(reg, "Applied").withArgs(1, alice.address, c);
      expect(await reg.commitments(1, alice.address)).to.equal(c);
      expect(await reg.balanceOf(alice.address)).to.equal(22);
      expect((await reg.getCourse(1)).applicants).to.equal(1);
    });

    it("rejects non-students", async function () {
      const { reg, outsider, apply } = await loadFixture(openFixture);
      await expect(apply(outsider, 0)).to.be.revertedWithCustomError(reg, "NotStudent");
    });

    it("rejects double application", async function () {
      const { reg, alice, apply } = await loadFixture(openFixture);
      await apply(alice, 0);
      await expect(apply(alice, 0)).to.be.revertedWithCustomError(reg, "AlreadyApplied");
    });

    it("rejects invalid course and empty commitment", async function () {
      const { reg, alice, apply } = await loadFixture(openFixture);
      await expect(apply(alice, 99)).to.be.revertedWithCustomError(reg, "InvalidCourse");
      await expect(reg.connect(alice).applyFor(0, ethers.ZeroHash)).to.be.revertedWithCustomError(reg, "InvalidParams");
    });

    it("more applicants than seats is fine: there is no race", async function () {
      const { reg, alice, bob, carol, apply } = await loadFixture(openFixture);
      for (const s of [alice, bob, carol]) await apply(s, 0); // capacity 2
      expect((await reg.getCourse(0)).applicants).to.equal(3);
    });

    it("cannot apply to more than 30 AKTS", async function () {
      const { reg, alice, apply } = await loadFixture(openFixture);
      await apply(alice, 2); // 20 -> 10 left
      await apply(alice, 1); // 8 -> 2 left
      await expect(apply(alice, 0)) // needs 6, has 2
        .to.be.revertedWithCustomError(reg, "InsufficientAKTS")
        .withArgs(2, 6);
    });
  });

  describe("Reveal", function () {
    async function appliedFixture() {
      const f = await openFixture();
      for (const s of [f.alice, f.bob, f.carol]) await f.apply(s, 0);
      await time.increaseTo(f.applyEnd);
      return f;
    }
    const reveal = (reg, student, courseId, secret = secretOf(student.address)) =>
      reg.connect(student).reveal(courseId, secret);

    it("is only possible in the reveal window", async function () {
      const { reg, alice, apply, revealEnd } = await loadFixture(openFixture);
      await apply(alice, 0);
      await expect(reveal(reg, alice, 0)).to.be.revertedWithCustomError(reg, "WrongPhase");
      await time.increaseTo(revealEnd);
      expect(await reg.phase()).to.equal(3);
      await expect(reveal(reg, alice, 0)).to.be.revertedWithCustomError(reg, "WrongPhase");
    });

    it("accepts the right secret and adds the student to the pool", async function () {
      const { reg, alice } = await loadFixture(appliedFixture);
      const secret = secretOf(alice.address);
      await expect(reveal(reg, alice, 0)).to.emit(reg, "Revealed").withArgs(0, alice.address, secret);
      expect(await reg.revealed(0, alice.address)).to.equal(true);
      expect(await reg.getPool(0)).to.deep.equal([alice.address]);
      expect(await reg.seedAcc(0)).to.equal(secret);
    });

    it("rejects a wrong secret, a double reveal and a student who did not apply", async function () {
      const { reg, alice, outsider } = await loadFixture(appliedFixture);
      await expect(reveal(reg, alice, 0, ethers.id("wrong"))).to.be.revertedWithCustomError(reg, "WrongSecret");
      await reveal(reg, alice, 0);
      await expect(reveal(reg, alice, 0)).to.be.revertedWithCustomError(reg, "AlreadyRevealed");
      await expect(reveal(reg, outsider, 0)).to.be.revertedWithCustomError(reg, "NotApplied");
    });

    it("cannot reuse someone else's secret: commitments are bound to the sender", async function () {
      const { reg, alice, bob } = await loadFixture(appliedFixture);
      await expect(reveal(reg, bob, 0, secretOf(alice.address))).to.be.revertedWithCustomError(reg, "WrongSecret");
    });

    it("seed does not depend on reveal order", async function () {
      const { reg, alice, bob, carol } = await loadFixture(appliedFixture);
      for (const s of [carol, alice, bob]) await reveal(reg, s, 0);
      const expected = [alice, bob, carol].map((s) => BigInt(secretOf(s.address))).reduce((a, b) => a ^ b);
      expect(BigInt(await reg.seedAcc(0))).to.equal(expected);
    });
  });
});
